// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dotNS reads over one Asset Hub client, built on first use and again after its follow stops. The connection is
// passed in, so the resolver reads through the follow its owner already keeps: the light client's broker in the
// protocol frame, the host's chain pool on a gateway.

import { createClient, DisjointError, RpcError } from '@polkadot-api/substrate-client';
import type { JsonRpcProvider } from 'polkadot-api';
import { TIMEOUTS, type DotnsContracts } from '@dotli/config';
import { captureException, m, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, log } from '@dotli/shared';

import { namehash, toHex, decodeIpfsContenthashResult } from './abi.js';
import { readMappingBytes, readMappingAddress } from './access-raw-storage.js';
import type { PhaseCallback, ResolvePhase } from './access-raw-storage.js';
import { createRawApi, type Api } from './api.js';
import { ContenthashDecodeError, NetworkSyncTimeoutError, UnsupportedContenthashCodecError } from './errors.js';
import { readExecutableManifest, readRootManifest } from './manifest.js';
import type { ExecutableKind, ExecutableManifest, ManifestResult, RootManifest } from './manifest.js';
import { raceSyncTimeout } from './sync-deadline.js';

export type { PhaseCallback, ResolvePhase } from './access-raw-storage.js';

const PEOPLE_CHAIN = 'People Paseo';

export interface ResolveOptions {
  onPhase?: PhaseCallback | undefined;
  /** What is left of the caller's deadline, if it set one. */
  syncTimeoutMs?: number;
}

/** A chain client: its raw reads, and the teardown of its follow and connection. */
export interface ChainClient {
  readonly api: Api;
  destroy: () => void;
}

export interface DotnsResolverDeps {
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
}

/** Where the Asset Hub client stands. A stopped follow takes it back to `idle`, and the next read builds it again. */
type DotnsResolverStatus = 'idle' | 'connecting' | 'syncing' | 'ready' | 'failed';

export interface DotnsResolver {
  resolveDotName: (label: string, opts?: ResolveOptions) => Promise<string | null>;
  resolveOwner: (label: string, opts?: ResolveOptions) => Promise<string | null>;
  resolveExecutableManifest: (
    label: string,
    kind: ExecutableKind,
    opts?: ResolveOptions,
  ) => Promise<ManifestResult<ExecutableManifest>>;
  resolveRootManifest: (label: string, opts?: ResolveOptions) => Promise<ManifestResult<RootManifest>>;
  /** Settles once Asset Hub is synced: the client setup of `resolveDotName` without the name read. */
  waitForAssetHubFinalized: () => Promise<void>;
  /**
   * Keeps People synced for legacy-account auth, whose cold read would race the warp sync. Resolution never needs
   * People, so callers must not gate on it.
   */
  waitForPeopleFinalized: () => Promise<void>;
}

const PHASES: Partial<Record<DotnsResolverStatus, ResolvePhase>> = {
  connecting: 'asset-hub-connecting',
  syncing: 'asset-hub-syncing',
  ready: 'asset-hub-ready',
};

const HUB_CHAIN: Record<DotnsResolverDeps['source'], string> = {
  'light-client': 'Asset Hub Paseo',
  'rpc-gateway': 'Asset Hub RPC',
};

// Repeats `CHAIN_HALTED_ERROR_DATA` from `@dotli/chains`, which the resolver does not import.
const CHAIN_HALTED_ERROR_DATA = 'dotli:chain-halted';

/**
 * The follow's `stop` already dropped the client, so a retry gets a rebuilt chain. A halt shows as the pool's
 * marked answer, as `ApiStoppedError`, or as papi's `DisjointError` for an operation already running.
 */
function isChainHalt(err: unknown): boolean {
  if (err instanceof RpcError) {
    return err.data === CHAIN_HALTED_ERROR_DATA;
  }
  return err instanceof DisjointError || (err instanceof Error && err.name === 'ApiStoppedError');
}

/**
 * A light client resuming from a stored database stops its stale-head follows on catch-up, up to twice,
 * so one retry is not enough. Bounded so a chain that dies instantly cannot spin a caller with no deadline.
 */
const MAX_HALT_ATTEMPTS = 4;

function openRawClient(provider: JsonRpcProvider): ChainClient {
  const client = createClient(provider);
  const api = createRawApi(client);
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

/** Builds the dotNS reads on the connections it is given. Each instance keeps its own clients. */
export function createDotnsResolver(deps: DotnsResolverDeps): DotnsResolver {
  const open = deps.open ?? openRawClient;
  const hubChain = HUB_CHAIN[deps.source];
  // A gateway's timings would skew the light client's dashboards.
  const timed = deps.source === 'light-client';
  const span = <T>(name: string, work: () => Promise<T>): Promise<T> => (timed ? m.span(name, work) : work());
  // One build at a time per chain. A queued caller finds the client its predecessor built.
  const clients = createAsyncTaskPool({ poolSize: 1 });
  const reads = createAsyncTaskPool({
    poolSize: Number.POSITIVE_INFINITY,
    retryCount: MAX_HALT_ATTEMPTS - 1,
    retryIf: isChainHalt,
  });

  let status: DotnsResolverStatus = 'idle';
  const listeners = new Set<(status: DotnsResolverStatus) => void>();
  function setStatus(next: DotnsResolverStatus): void {
    if (next === status) {
      return;
    }
    status = next;
    // A callback's throw must not fail the shared build, nor leave the status behind a client already kept.
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (err) {
        captureException(err, { flow: 'resolve', step: 'phase_callback', tags: { status: next } });
        log.error('[dot.li resolve] A resolver phase callback threw', err);
      }
    }
  }
  /** Hears each later status. Returns the unsubscribe. */
  function onStatus(listener: (status: DotnsResolverStatus) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  let hub: ChainClient | null = null;
  let people: ChainClient | null = null;

  async function buildAssetHub(): Promise<Api> {
    const initStart = performance.now();
    let outcome: 'ok' | 'error' | 'timeout' = 'error';
    try {
      setStatus('connecting');
      const client = open(deps.assetHub());
      setStatus('syncing');
      const syncStart = performance.now();
      let syncMs: number;
      // Kept only once ready, and torn down on failure, so no orphaned client keeps a subscription alive.
      // The wait is bounded, since an unreachable peer set leaves `whenReady()` pending forever.
      try {
        await span(S.SMOLDOT_FINALIZED_BLOCK, () =>
          raceSyncTimeout(client.api.whenReady(), hubChain, TIMEOUTS.HUB_FINALIZED_SYNC),
        );
        syncMs = performance.now() - syncStart;
        if (timed) {
          m.measure(S.SMOLDOT_FINALIZED_BLOCK, syncMs);
          m.distribution(S.SMOLDOT_FINALIZED_BLOCK, syncMs);
        }
      } catch (err) {
        client.destroy();
        throw err;
      }

      // A dead follow would otherwise make every later read return `null`, which reads as "name not found".
      client.api.onStop(() => {
        log.warn('[dot.li resolve] chainHead follow stopped, invalidating resolver client');
        if (hub === client) {
          hub = null;
          client.destroy();
          setStatus('idle');
        }
      });

      hub = client;
      outcome = 'ok';
      log.event('Asset Hub client ready', {
        flow: 'resolve',
        source: deps.source,
        sync_ms: Math.round(syncMs),
        total_ms: Math.round(performance.now() - initStart),
      });
      setStatus('ready');
      return client.api;
    } catch (err) {
      if (err instanceof NetworkSyncTimeoutError) {
        outcome = 'timeout';
      }
      setStatus('failed');
      throw err;
    } finally {
      // Recorded here alone, since the SharedWorker presync and direct mode both come through here.
      if (timed) {
        const totalMs = performance.now() - initStart;
        if (outcome === 'ok') {
          m.measure(S.SMOLDOT_PRESYNC, totalMs);
        }
        m.distribution(S.SMOLDOT_PRESYNC, totalMs, 'millisecond', { outcome });
      }
    }
  }

  /** The caller hears how far the client has come while it waits. */
  function reportProgress(onPhase: PhaseCallback | undefined): () => void {
    if (onPhase === undefined) {
      return () => undefined;
    }
    return onStatus(next => {
      const phase = PHASES[next];
      if (phase !== undefined) {
        onPhase(phase);
      }
    });
  }

  /** The caller's budget, never past the cap, so a wait queued behind failing builds still ends at the cap. */
  function budgetOf(opts: ResolveOptions): number {
    return Math.min(opts.syncTimeoutMs ?? TIMEOUTS.HUB_FINALIZED_SYNC, TIMEOUTS.HUB_FINALIZED_SYNC);
  }

  function assetHubApi(opts: ResolveOptions): Promise<Api> {
    const stopReporting = reportProgress(opts.onPhase);
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
    return raceSyncTimeout(ready, hubChain, budgetOf(opts))
      .catch((err: unknown) => {
        // A caller that gave up while queued must not start a build nobody waits for.
        gaveUp.abort(err);
        throw err;
      })
      .finally(stopReporting);
  }

  /** Every retry gets what is left of the caller's budget, not a fresh one. */
  function read<T>(opts: ResolveOptions, run: (api: Api, opts: ResolveOptions) => Promise<T>): Promise<T> {
    const started = performance.now();
    const budget = budgetOf(opts);
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
      const attempt = { ...opts, syncTimeoutMs: left };
      return run(await assetHubApi(attempt), attempt);
    });
  }

  async function readDotName(api: Api, label: string, opts: ResolveOptions): Promise<string | null> {
    const domain = `${label}.${deps.dotns.TLD}`;
    const node = namehash(domain);

    opts.onPhase?.('resolving-content');
    const contentStart = performance.now();

    const contenthashBytes = await span(S.RESOLVE_STORAGE_READ, () =>
      readMappingBytes(api, deps.dotns.DOTNS_CONTENT_RESOLVER, node, deps.dotns.STORAGE_SLOTS.CONTENTHASH),
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
    const node = namehash(`${label}.${deps.dotns.TLD}`);
    return readMappingAddress(api, deps.dotns.DOTNS_REGISTRY, node, deps.dotns.STORAGE_SLOTS.REGISTRY_RECORDS);
  }

  async function buildPeople(connect: () => JsonRpcProvider): Promise<void> {
    const initStart = performance.now();
    const client = open(connect());
    try {
      await raceSyncTimeout(client.api.whenReady(), PEOPLE_CHAIN, TIMEOUTS.PEOPLE_FINALIZED_SYNC);
    } catch (err) {
      client.destroy();
      throw err;
    }
    client.api.onStop(() => {
      log.warn('[dot.li resolve] People chainHead follow stopped, invalidating warm client');
      if (people === client) {
        people = null;
        client.destroy();
      }
    });
    people = client;
    log.event('People chain warmed', { flow: 'resolve', ms: Math.round(performance.now() - initStart) });
  }

  return {
    resolveDotName: (label, opts = {}) => read(opts, (api, attempt) => readDotName(api, label, attempt)),
    resolveOwner: (label, opts = {}) => read(opts, api => readOwner(api, label)),
    resolveExecutableManifest: (label, kind, opts = {}) =>
      read(opts, api => readExecutableManifest(api, deps.dotns, label, kind)),
    resolveRootManifest: (label, opts = {}) => read(opts, api => readRootManifest(api, deps.dotns, label)),
    waitForAssetHubFinalized: async () => {
      await assetHubApi({});
    },
    waitForPeopleFinalized: async () => {
      const connect = deps.people;
      if (connect === undefined) {
        log.debug('[dot.li resolve] No People connection, so no warm-keep. People resolves on demand via the broker.');
        return;
      }
      await clients.call(() => (people === null ? buildPeople(connect) : undefined), { pool: 'people' });
    },
  };
}
