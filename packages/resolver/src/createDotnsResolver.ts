// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dotNS reads over one Asset Hub client, built on first use and again after its follow stops. The connection is
// passed in, so the resolver reads through the follow its owner already keeps: the light client's broker in the
// protocol frame, the host's chain pool on a gateway.

import { createClient, DisjointError, RpcError } from '@polkadot-api/substrate-client';
import type { JsonRpcProvider } from 'polkadot-api';
import { atom } from 'nanostores';
import { TIMEOUTS, type DotnsContracts } from '@dotli/config';
import { m, reportListener, spans as S } from '@dotli/metrics';
import { CHAIN_HALTED_ERROR_DATA, createAsyncTaskPool, log, toHex, withTimeout } from '@dotli/shared';

import { ApiStoppedError } from './apiStoppedError.js';
import { ContenthashDecodeError } from './contenthashDecodeError.js';
import { createRawApi, type Api } from './createRawApi.js';
import { decodeIpfsContenthashResult } from './decodeIpfsContenthashResult.js';
import type { ExecutableKind } from './manifestTypes.js';
import { NetworkSyncTimeoutError } from './networkSyncTimeoutError.js';
import { readExecutableManifest } from './readExecutableManifest.js';
import { readMappingAddress } from './readMappingAddress.js';
import { readMappingBytes } from './readMappingBytes.js';
import { readRootManifest } from './readRootManifest.js';
import { computeNamehash } from './storageSlots.js';
import type { PhaseCallback, ResolvePhase } from './types.js';
import { UnsupportedContenthashCodecError } from './unsupportedContenthashCodecError.js';

export type ResolveOptions = {
  onPhase?: PhaseCallback | undefined;
  /** What is left of the caller's deadline, if it set one. */
  syncTimeoutMs?: number;
};

/** A chain client: its raw reads, and the teardown of its follow and connection. */
export type ChainClient = {
  /** The raw reads over this client's follow. */
  readonly api: Api;
  /** Tears down the follow and the connection. Never throws. */
  destroy: () => void;
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

/** Where the Asset Hub client stands. A stopped follow takes it back to `idle`, and the next read builds it again. */
type DotnsResolverStatus = 'idle' | 'connecting' | 'syncing' | 'ready' | 'failed';

const PEOPLE_CHAIN = 'People Paseo';
/** Upper bound on the background People-chain warm for legacy-account auth. */
const PEOPLE_FINALIZED_SYNC_MS = 180_000;

const PHASES: Partial<Record<DotnsResolverStatus, ResolvePhase>> = {
  connecting: 'asset-hub-connecting',
  syncing: 'asset-hub-syncing',
  ready: 'asset-hub-ready',
};

const HUB_CHAIN: Record<Params['source'], string> = {
  'light-client': 'Asset Hub Paseo',
  'rpc-gateway': 'Asset Hub RPC',
};

/**
 * A light client resuming from a stored database stops its stale-head follows on catch-up, up to twice,
 * so one retry is not enough. Bounded so a chain that dies instantly cannot spin a caller with no deadline.
 */
const MAX_HALT_ATTEMPTS = 4;

const reportPhaseListener = reportListener('resolve', 'resolver.status');

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
  // One build at a time per chain. A queued caller finds the client its predecessor built.
  const clients = createAsyncTaskPool({ poolSize: 1 });
  const reads = createAsyncTaskPool({
    poolSize: Number.POSITIVE_INFINITY,
    retryCount: MAX_HALT_ATTEMPTS - 1,
    retryIf: isChainHalt,
  });

  const status = atom<DotnsResolverStatus>('idle');

  let hub: ChainClient | null = null;
  let peopleClient: ChainClient | null = null;

  function measureSpan<T>(name: string, work: () => Promise<T>): Promise<T> {
    return timed ? m.span(name, work) : work();
  }

  async function buildAssetHub(): Promise<Api> {
    const initStart = performance.now();
    let outcome: 'ok' | 'error' | 'timeout' = 'error';
    try {
      status.set('connecting');
      const client = open(assetHub());
      status.set('syncing');
      const syncStart = performance.now();
      let syncMs: number;
      // Kept only once ready, and torn down on failure, so no orphaned client keeps a subscription alive.
      try {
        // `api.whenReady()` never settles without reachable peers, so the wait is bounded and its error names the cause.
        await measureSpan(S.SMOLDOT_FINALIZED_BLOCK, () =>
          withTimeout({
            work: client.api.whenReady(),
            ms: TIMEOUTS.HUB_FINALIZED_SYNC,
            timeoutError: () => new NetworkSyncTimeoutError(hubChain, TIMEOUTS.HUB_FINALIZED_SYNC),
          }),
        );
        syncMs = performance.now() - syncStart;
        if (timed) {
          m.measure(S.SMOLDOT_FINALIZED_BLOCK, syncMs);
          m.distribution(S.SMOLDOT_FINALIZED_BLOCK, syncMs);
        }
      } catch (error) {
        client.destroy();
        throw error;
      }

      // A dead follow would otherwise make every later read return `null`, which reads as "name not found".
      client.api.onStop(() => {
        log.warn('[dot.li resolve] chainHead follow stopped, invalidating resolver client');
        if (hub === client) {
          hub = null;
          client.destroy();
          status.set('idle');
        }
      });

      hub = client;
      outcome = 'ok';
      log.event('Asset Hub client ready', {
        flow: 'resolve',
        source,
        sync_ms: Math.round(syncMs),
        total_ms: Math.round(performance.now() - initStart),
      });
      status.set('ready');
      return client.api;
    } catch (error) {
      if (error instanceof NetworkSyncTimeoutError) {
        outcome = 'timeout';
      }
      status.set('failed');
      throw error;
    } finally {
      // Recorded here alone, since the SharedWorker presync and direct mode both come through here.
      if (timed) {
        const totalMs = performance.now() - initStart;
        if (outcome === 'ok') {
          m.measure(S.SMOLDOT_PRESYNC, totalMs);
        }
        m.distribution(S.SMOLDOT_PRESYNC, totalMs, { unit: 'millisecond', attributes: { outcome } });
      }
    }
  }

  /** The caller hears how far the client has come while it waits. */
  function reportProgress(onPhase: PhaseCallback | undefined): () => void {
    if (onPhase === undefined) {
      return () => undefined;
    }
    // A caller that arrives after a phase was reached hears it too.
    return status.subscribe(next => {
      tellPhase(onPhase, next);
    });
  }

  /** The caller's budget, never past the cap, so a wait queued behind failing builds still ends at the cap. */
  function getBudget(options: ResolveOptions): number {
    return Math.min(options.syncTimeoutMs ?? TIMEOUTS.HUB_FINALIZED_SYNC, TIMEOUTS.HUB_FINALIZED_SYNC);
  }

  function getAssetHubApi(options: ResolveOptions): Promise<Api> {
    const stopReporting = reportProgress(options.onPhase);
    const gaveUp = new AbortController();
    // Checked in the task, not passed to the pool: aborting a running build would free its slot for a second one.
    const ready = clients.call(
      () => {
        gaveUp.signal.throwIfAborted();
        return hub?.api ?? buildAssetHub();
      },
      { pool: 'asset-hub' },
    );
    // The shared client keeps the full budget, so a short caller cannot cut short a longer one.
    const budget = getBudget(options);
    return withTimeout({ work: ready, ms: budget, timeoutError: () => new NetworkSyncTimeoutError(hubChain, budget) })
      .catch((error: unknown) => {
        // A caller that gave up while queued must not start a build nobody waits for.
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
        log.event('Resolve retry after a chain halt', { flow: 'resolve', attempt: attempts, left_ms: left });
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

    const contenthashBytes = await measureSpan(S.RESOLVE_STORAGE_READ, () =>
      readMappingBytes({
        api,
        contractAddress: dotns.DOTNS_CONTENT_RESOLVER,
        mappingKey: node,
        mappingSlot: dotns.STORAGE_SLOTS.CONTENTHASH,
      }),
    );
    const contentMs = performance.now() - contentStart;
    if (timed) {
      m.measure(S.RESOLVE_STORAGE_READ, contentMs);
    }
    log.event('Contenthash read', { flow: 'resolve', found: contenthashBytes !== null, ms: Math.round(contentMs) });

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

  function readOwner(api: Api, label: string): Promise<string | null> {
    const node = computeNamehash(`${label}.${dotns.TLD}`);
    return readMappingAddress({
      api,
      contractAddress: dotns.DOTNS_REGISTRY,
      mappingKey: node,
      mappingSlot: dotns.STORAGE_SLOTS.REGISTRY_RECORDS,
    });
  }

  async function buildPeople(connect: () => JsonRpcProvider): Promise<void> {
    const initStart = performance.now();
    const client = open(connect());
    try {
      await withTimeout({
        work: client.api.whenReady(),
        ms: PEOPLE_FINALIZED_SYNC_MS,
        timeoutError: () => new NetworkSyncTimeoutError(PEOPLE_CHAIN, PEOPLE_FINALIZED_SYNC_MS),
      });
    } catch (error) {
      client.destroy();
      throw error;
    }
    client.api.onStop(() => {
      log.warn('[dot.li resolve] People chainHead follow stopped, invalidating warm client');
      if (peopleClient === client) {
        peopleClient = null;
        client.destroy();
      }
    });
    peopleClient = client;
    log.event('People chain warmed', { flow: 'resolve', ms: Math.round(performance.now() - initStart) });
  }

  return {
    /**
     * Reads the IPFS CID a label's contenthash points at, or `null` when the name has none. Rejects with
     * `UnsupportedContenthashCodecError` or `ContenthashDecodeError` for a contenthash dotli cannot fetch,
     * `PartialStorageReadError` when the read stops partway, `NetworkSyncTimeoutError` when Asset Hub does not sync
     * within the budget, and the read's own error when it fails for any other reason or the chain keeps halting.
     */
    resolveDotName: (label: string, options: ResolveOptions = {}): Promise<string | null> =>
      read(options, (api, attempt) => readDotName({ api, label, options: attempt })),
    /**
     * Reads the address that owns a label, or `null` when the name is unregistered. Rejects with
     * `NetworkSyncTimeoutError` when Asset Hub does not sync within the budget, and the read's own error when it fails
     * for any other reason or the chain keeps halting.
     */
    resolveOwner: (label: string, options: ResolveOptions = {}): Promise<string | null> =>
      read(options, api => readOwner(api, label)),
    /**
     * Reads the manifest a label publishes for `kind`, as a result the caller branches on. Rejects with
     * `PartialStorageReadError` when the read stops partway, `NetworkSyncTimeoutError` when Asset Hub does not sync
     * within the budget, and the read's own error when it fails for any other reason or the chain keeps halting.
     */
    resolveExecutableManifest: (label: string, kind: ExecutableKind, options: ResolveOptions = {}) =>
      read(options, api => readExecutableManifest({ api, dotns, label, kind })),
    /**
     * Reads a label's root manifest, as a result the caller branches on. Rejects with `PartialStorageReadError` when
     * the read stops partway, `NetworkSyncTimeoutError` when Asset Hub does not sync within the budget, and the read's
     * own error when it fails for any other reason or the chain keeps halting.
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
     * time, or the client's own error.
     */
    waitForPeopleFinalized: async (): Promise<void> => {
      if (people === undefined) {
        log.debug('[dot.li resolve] No People connection, so no warm-keep. People resolves on demand via the broker.');
        return;
      }
      await clients.call(() => (peopleClient === null ? buildPeople(people) : undefined), { pool: 'people' });
    },
  };
}

/**
 * The follow's `stop` already dropped the client, so a retry gets a rebuilt chain. A halt shows as the pool's
 * marked answer, as `ApiStoppedError`, or as papi's `DisjointError` for an operation already running.
 */
function isChainHalt(error: unknown): boolean {
  if (error instanceof RpcError) {
    return error.data === CHAIN_HALTED_ERROR_DATA;
  }
  return error instanceof DisjointError || error instanceof ApiStoppedError;
}

/** Tells `onPhase` the phase a client status stands for, if it stands for one, and reports a throw from it. */
function tellPhase(onPhase: PhaseCallback, next: DotnsResolverStatus): void {
  const phase = PHASES[next];
  if (phase === undefined) {
    return;
  }
  // The callback's own throw must not fail the shared build, nor leave the status behind a client already kept. A throw
  // from a listener of a store the callback writes still reaches the build.
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
        // eslint-disable-next-line no-restricted-syntax -- a panicked smoldot may throw here, and the owner must still let go of the client.
      } catch {
        /* already dead */
      }
    },
  };
}
