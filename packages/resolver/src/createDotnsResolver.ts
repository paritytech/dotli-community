// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dotNS reads over one Asset Hub client, built on first use and again after its follow stops. The connection is
// passed in, so the resolver reads through the follow its owner already keeps: the light client's broker in the
// protocol frame, the host's chain pool on a gateway.

import { createClient, DisjointError } from '@polkadot-api/substrate-client';
import type { JsonRpcProvider } from 'polkadot-api';
import { TIMEOUTS, type DotnsContracts } from '@dotli/config';
import { createReporter, defineCount, m } from '@dotli/metrics';
import { createAsyncTaskPool, isChainHaltedRpcError, log, toHex, withTimeout } from '@dotli/shared';

import { ApiStoppedError } from './apiStoppedError.js';
import { ContenthashDecodeError } from './contenthashDecodeError.js';
import { createRawApi, type Api } from './createRawApi.js';
import { createSyncedClient, type ChainClient, type SyncedClientState } from './createSyncedClient.js';
import { decodeIpfsContenthashResult } from './decodeIpfsContenthashResult.js';
import type { ExecutableKind } from './manifestTypes.js';
import { NetworkSyncTimeoutError } from './networkSyncTimeoutError.js';
import { readExecutableManifest } from './readExecutableManifest.js';
import { readNameOwner } from './readNameOwner.js';
import { readPinnedBytes } from './readPinnedBytes.js';
import { readRootManifest } from './readRootManifest.js';
import { computeMappingSlot, computeNamehash } from './storageSlots.js';
import type { PhaseCallback, ResolvePhase } from './types.js';
import { UnsupportedContenthashCodecError } from './unsupportedContenthashCodecError.js';

const report = createReporter({ flow: 'resolve' });

const RESOLVE_STORAGE_READ = 'resolve.storage_read';

/**
 * Count. A chain client whose teardown threw. Tagged `outcome` (error) and `reason` (the error's name):
 * `AlreadyDestroyedError` or `CrashError` for a light client that ended or panicked, and any other name for a bug.
 */
const clientDestroyMetric = defineCount<'error'>('resolve.client_destroy');

// A panicked smoldot says so in its message, while its own class names may not survive the bundle.
const SMOLDOT_GONE_PATTERN = /panicked at|Smoldot has (?:panicked|crashed)/i;

export type ResolveOptions = {
  onPhase?: PhaseCallback | undefined;
  /** What is left of the caller's deadline, if it set one. */
  syncTimeoutMs?: number;
};

export type DotnsResolver = ReturnType<typeof createDotnsResolver>;

type Params = {
  /** Opens the Asset Hub connection the reads go over, again for each client after a follow stops. */
  assetHub: () => JsonRpcProvider;
  /**
   * Opens People for the warm-keep, which does nothing without it. A follow of the resolver's own would share the
   * light client's one response queue with the broker, which would drop its events.
   */
  people?: () => JsonRpcProvider;
  /** The naming contracts of the network the reads target. */
  dotns: DotnsContracts;
  /** What the connection runs on. Only the light client's sync and read timings are recorded. */
  source: 'light-client' | 'rpc-gateway';
  /** Opens a client on a connection. Defaults to papi's raw client. */
  open?: (provider: JsonRpcProvider) => ChainClient;
};

const PHASES = {
  idle: null,
  connecting: 'asset-hub-connecting',
  syncing: 'asset-hub-syncing',
  ready: 'asset-hub-ready',
  failed: null,
} satisfies Record<SyncedClientState['kind'], ResolvePhase | null>;

const HUB_CHAIN: Record<Params['source'], string> = {
  'light-client': 'Asset Hub Paseo',
  'rpc-gateway': 'Asset Hub RPC',
};

/**
 * A light client resuming from a stored database stops its stale-head follows on catch-up, up to twice,
 * so one retry is not enough. Bounded so a chain that dies instantly cannot spin a caller with no deadline.
 */
const MAX_HALT_ATTEMPTS = 4;

const reportPhaseListener = report.listener('resolver.status');

/**
 * Builds the dotNS reads on the connections it is given. Each instance keeps its own clients.
 *
 * @example
 * const dotns = createDotnsResolver({ assetHub: openAssetHub, dotns: contracts, source: 'rpc-gateway' });
 * const cid = await dotns.resolveDotName('alice'); // null when the name has no contenthash
 */
export function createDotnsResolver({ assetHub, people, dotns, source, open = openRawClient }: Params) {
  const hubChain = HUB_CHAIN[source];
  // A gateway's timings would skew the light client's dashboards.
  const timed = source === 'light-client';
  const reads = createAsyncTaskPool({
    poolSize: Number.POSITIVE_INFINITY,
    retryCount: MAX_HALT_ATTEMPTS - 1,
    retryIf: isChainHalt,
  });
  const assetHubClient = createSyncedClient({
    chain: hubChain,
    syncTimeoutMs: TIMEOUTS.HUB_FINALIZED_SYNC,
    timed,
    openClient: () => open(assetHub()),
  });
  const peopleClient =
    people === undefined
      ? null
      : createSyncedClient({
          chain: 'People Paseo',
          // Upper bound on the background People-chain warm for legacy-account auth.
          syncTimeoutMs: 180_000,
          timed: false,
          openClient: () => open(people()),
        });

  /** The caller hears how far the client has come while it waits. */
  function reportProgress(onPhase: PhaseCallback | undefined): () => void {
    if (onPhase === undefined) {
      return () => undefined;
    }
    // A caller that arrives after a phase was reached hears it too.
    return assetHubClient.state.subscribe(next => {
      tellPhase(onPhase, next.kind);
    });
  }

  /** The caller's budget, never past the cap, so a wait queued behind failing builds still ends at the cap. */
  function getBudget(options: ResolveOptions): number {
    return Math.min(options.syncTimeoutMs ?? TIMEOUTS.HUB_FINALIZED_SYNC, TIMEOUTS.HUB_FINALIZED_SYNC);
  }

  function getAssetHubApi(options: ResolveOptions): Promise<Api> {
    const stopReporting = reportProgress(options.onPhase);
    // Aborted when this caller gives up, so it starts no build nobody waits for.
    const gaveUp = new AbortController();
    // The shared client keeps the full budget, so a short caller cannot cut short a longer one.
    const budget = getBudget(options);
    return withTimeout({
      work: assetHubClient.getApi({ signal: gaveUp.signal }),
      ms: budget,
      timeoutError: () => new NetworkSyncTimeoutError(hubChain, budget),
    })
      .catch((error: unknown) => {
        gaveUp.abort(error);
        throw error;
      })
      .finally(stopReporting);
  }

  /** Every retry gets what is left of the caller's budget, not a fresh one. */
  function read<T>(options: ResolveOptions, run: (api: Api, options: ResolveOptions) => Promise<T>): Promise<T> {
    const started = performance.now();
    const budget = getBudget(options);
    let attempts = 0;
    return reads.call(async () => {
      const left = Math.floor(budget - (performance.now() - started));
      // A halt after the budget is spent fails here, so the retry opens no client nobody waits for.
      if (left <= 0) {
        throw new NetworkSyncTimeoutError(hubChain, budget);
      }
      attempts += 1;
      if (attempts > 1) {
        report.log.event('Resolve retry after a chain halt', { attempt: attempts, left_ms: left });
      }
      const attempt = { ...options, syncTimeoutMs: left };
      return run(await getAssetHubApi(attempt), attempt);
    });
  }

  async function readDotName({
    api,
    label,
    options,
  }: {
    api: Api;
    label: string;
    options: ResolveOptions;
  }): Promise<string | null> {
    const domain = `${label}.${dotns.TLD}`;
    const node = computeNamehash(domain);

    options.onPhase?.('resolving-content');
    const contentStart = performance.now();

    const readContenthash = () =>
      readPinnedBytes({
        api,
        contractAddress: dotns.DOTNS_CONTENT_RESOLVER,
        baseSlotKey: computeMappingSlot(node, dotns.STORAGE_SLOTS.CONTENTHASH),
        context: { mappingKind: 'mapping bytes' },
      });
    const contenthashBytes = await (timed ? m.span(RESOLVE_STORAGE_READ, readContenthash) : readContenthash());
    const contentMs = performance.now() - contentStart;
    if (timed) {
      m.measure(RESOLVE_STORAGE_READ, contentMs);
    }
    report.log.event('Contenthash read', { found: contenthashBytes !== null, ms: Math.round(contentMs) });

    if (contenthashBytes === null) {
      return null;
    }

    const decoded = decodeIpfsContenthashResult(toHex(contenthashBytes));
    switch (decoded.kind) {
      case 'ok':
        return decoded.cid;
      case 'empty':
        return null;
      case 'unsupported-codec':
        throw new UnsupportedContenthashCodecError(domain, decoded.codec);
      case 'decode-error':
        throw new ContenthashDecodeError(domain, decoded.cause);
    }
  }

  return {
    /**
     * Reads the IPFS CID a label's contenthash points at, or `null` when the name has none. Rejects with
     * `UnsupportedContenthashCodecError` or `ContenthashDecodeError` for a contenthash dotli cannot fetch,
     * `PartialStorageReadError` when the read stops partway, `CorruptBytesSlotError` when a stored value's length
     * cannot be read, `NetworkSyncTimeoutError` when Asset Hub does not sync within the budget, and the read's own
     * error when it fails for any other reason or the chain keeps halting.
     */
    resolveDotName: (label: string, options: ResolveOptions = {}): Promise<string | null> =>
      read(options, (api, attempt) => readDotName({ api, label, options: attempt })),
    /**
     * Reads the address that owns a label, or `null` when the name is unregistered. Rejects with
     * `NetworkSyncTimeoutError` when Asset Hub does not sync within the budget, and the read's own error when it fails
     * for any other reason or the chain keeps halting.
     */
    resolveOwner: (label: string, options: ResolveOptions = {}): Promise<string | null> =>
      read(options, api => readNameOwner({ api, dotns, label })),
    /**
     * Reads the manifest a label publishes for `kind`, as a result the caller branches on. Rejects with
     * `PartialStorageReadError` when the read stops partway, `CorruptBytesSlotError` when a stored value's length
     * cannot be read, `NetworkSyncTimeoutError` when Asset Hub does not sync within the budget, and the read's own
     * error when it fails for any other reason or the chain keeps halting.
     */
    resolveExecutableManifest: (label: string, kind: ExecutableKind, options: ResolveOptions = {}) =>
      read(options, api => readExecutableManifest({ api, dotns, label, kind })),
    /**
     * Reads a label's root manifest, as a result the caller branches on. Rejects with `PartialStorageReadError` when
     * the read stops partway, `CorruptBytesSlotError` when a stored value's length cannot be read,
     * `NetworkSyncTimeoutError` when Asset Hub does not sync within the budget, and the read's own error when it
     * fails for any other reason or the chain keeps halting.
     */
    resolveRootManifest: (label: string, options: ResolveOptions = {}) =>
      read(options, api => readRootManifest({ api, dotns, label })),
    /**
     * Settles once Asset Hub is synced: the client setup of a name read without the read. Rejects with
     * `NetworkSyncTimeoutError` when it does not sync in time, or the client's own error.
     */
    waitForAssetHubFinalized: async (): Promise<void> => {
      await getAssetHubApi({});
    },
    /**
     * Keeps People synced for legacy-account auth, whose cold read would race the warp sync. Resolution never needs
     * People, so callers must not gate on it. Rejects with `NetworkSyncTimeoutError` when People does not sync in
     * time, with `ApiStoppedError` when its follow stops as it syncs, or the client's own error.
     */
    waitForPeopleFinalized: async (): Promise<void> => {
      if (peopleClient === null) {
        log.debug('[dot.li resolve] No People connection, so no warm-keep. People resolves on demand via the broker.');
        return;
      }
      await peopleClient.getApi();
    },
  };
}

/**
 * The follow's `stop` already dropped the client, so a retry gets a rebuilt chain. A halt shows as the pool's
 * marked answer, as `ApiStoppedError`, or as papi's `DisjointError` for an operation already running.
 */
function isChainHalt(error: unknown): boolean {
  return isChainHaltedRpcError(error) || error instanceof DisjointError || error instanceof ApiStoppedError;
}

/** Tells `onPhase` the phase a client status stands for, if it stands for one, and reports a throw from it. */
function tellPhase(onPhase: PhaseCallback, next: SyncedClientState['kind']): void {
  const phase = PHASES[next];
  if (phase === null) {
    return;
  }
  // The callback's own throw must not fail the shared build, nor leave the status behind a client already kept. A throw
  // from a listener of a store the callback writes still reaches the client's transition, which reports it.
  try {
    onPhase(phase);
  } catch (error) {
    reportPhaseListener(error);
  }
}

function openRawClient(provider: JsonRpcProvider): ChainClient {
  const client = createClient(provider);
  const api = createRawApi({ client });
  return {
    api,
    destroy: () => {
      try {
        api.destroy();
        client.destroy();
      } catch (error: unknown) {
        // A light client that ended or panicked throws as its chain is removed, which the environment causes.
        if (isLightClientGone(error)) {
          report.expected(error, { step: 'client_destroy', metric: clientDestroyMetric });
          return;
        }
        report.defect(error, {
          step: 'client_destroy',
          metric: clientDestroyMetric,
          message: '[dot.li resolve] A chain client teardown threw:',
        });
      }
    },
  };
}

/** Whether `error` is a light client's refusal because it already ended or panicked. */
function isLightClientGone(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === 'AlreadyDestroyedError' || error.name === 'CrashError' || SMOLDOT_GONE_PATTERN.test(error.message)
  );
}
