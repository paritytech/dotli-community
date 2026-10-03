// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dotNS name resolution via direct storage reads
//
// Uses polkadot-api with the shared Asset Hub provider from provider.ts.

import { createClient, DisjointError, RpcError, type SubstrateClient } from '@polkadot-api/substrate-client';
import type { JsonRpcProvider } from 'polkadot-api';
import { TIMEOUTS, getActiveServicesConfig } from '@dotli/config';

import { namehash, toHex, decodeIpfsContenthashResult } from './abi.js';
import { ContenthashDecodeError, NetworkSyncTimeoutError, UnsupportedContenthashCodecError } from './errors.js';
import { raceSyncTimeout, withSyncBudget } from './sync-deadline.js';
import { log } from '@dotli/shared';

import { m, spans as S } from '@dotli/metrics';
import { readMappingBytes, readMappingAddress } from './access-raw-storage.js';
import type { PhaseCallback, StatusCallback } from './access-raw-storage.js';
import { createRawApi, type Api } from './api.js';
import { readExecutableManifest, readRootManifest } from './manifest.js';
import type { ExecutableKind, ExecutableManifest, ManifestResult, RootManifest } from './manifest.js';

export type { StatusCallback, PhaseCallback, ResolvePhase } from './access-raw-storage.js';
export { statusToPhase } from './access-raw-storage.js';
export { onChainSync, enableSyncReporting, CHAIN_KEYS, CHAIN_SYNC_KINDS } from './chain-sync.js';
export { onChainDetail } from './chain-sync.js';
export type { ChainSyncEvent, ChainSyncKind, ChainKey, ChainDetail, ChainPeer } from './chain-sync.js';

const HUB_CHAIN = 'Asset Hub Paseo';

/** Shared shape for every resolver read that may have to wait on sync. */
export interface ResolveOptions {
  onStatus?: StatusCallback | undefined;
  onPhase?: PhaseCallback | undefined;
  /** Remaining budget from the caller's request deadline, if it set one. */
  syncTimeoutMs?: number;
}

let clientInstance: SubstrateClient | null = null;
let apiInstance: Api | null = null;
let clientPromise: Promise<Api> | null = null;

// Asset Hub provider used to read dotNS. The host injects a broker-backed
// provider during bootstrap so the resolver shares the broker's single Asset
// Hub follow instead of opening its own (see protocol-shared-worker).
let resolverAssetHubProvider: (() => JsonRpcProvider) | null = null;

export function setResolverAssetHubProvider(factory: (() => JsonRpcProvider) | null): void {
  resolverAssetHubProvider = factory;
}

// People-chain provider for the legacy-account auth warm-keep. Like Asset Hub,
// the host injects a broker-backed provider during bootstrap so the warm-keep
// shares the broker's single People follow. Opening a separate `getSmProvider`
// here would race the broker's follow on the same smoldot chain — a smoldot
// chain has one shared `nextJsonRpcResponse` queue, so subscription events get
// delivered to the wrong consumer and the broker drops People follow events as
// "unknown token", leaving reads to hang.
let resolverPeopleProvider: (() => JsonRpcProvider) | null = null;

export function setResolverPeopleProvider(factory: (() => JsonRpcProvider) | null): void {
  resolverPeopleProvider = factory;
}

/**
 * Tear down the cached resolver client. Callers that hold a reference to
 * `apiInstance` must discard it. Every subsequent `.` resolution rebuilds
 * against a fresh client. Used on a chain-backend switch that requires a new
 * client.
 */
export function destroyResolverClient(): void {
  if (clientInstance !== null) {
    log.event('Resolver client destroyed', { flow: 'resolve' });
    try {
      apiInstance?.destroy();
      clientInstance.destroy();
      // eslint-disable-next-line no-restricted-syntax -- best-effort teardown: if smoldot already panicked the client may throw; we still must clear our references below so the next ensureClient() starts fresh.
    } catch {
      /* already dead, clear references anyway */
    }
  }
  clientInstance = null;
  apiInstance = null;
  clientPromise = null;
}

function ensureClient(opts: ResolveOptions = {}): Promise<Api> {
  if (apiInstance !== null) {
    // Already synced. Emit the terminal phase so a late subscriber
    // still sees an accurate snapshot instead of staying on whatever
    // the previous phase was.
    opts.onPhase?.('asset-hub-ready');
    return Promise.resolve(apiInstance);
  }
  // The underlying client keeps the full sync budget so a short manifest
  // request cannot poison a concurrent name resolution with a longer
  // deadline. Each caller races this shared initialization below.
  clientPromise ??= doCreateClient(opts.onStatus, opts.onPhase).finally(() => {
    clientPromise = null;
  });
  return withSyncBudget(clientPromise, HUB_CHAIN, opts.syncTimeoutMs, TIMEOUTS.HUB_FINALIZED_SYNC);
}

async function doCreateClient(onStatus?: StatusCallback, onPhase?: PhaseCallback): Promise<Api> {
  const initStart = performance.now();
  let outcome: 'ok' | 'error' | 'timeout' = 'error';

  try {
    onPhase?.('light-client-starting');
    onStatus?.('Starting light client...');

    onPhase?.('asset-hub-connecting');
    onStatus?.('Connecting to Asset Hub Paseo...');
    if (resolverAssetHubProvider === null) {
      throw new Error('Resolver Asset Hub provider not set — call setResolverAssetHubProvider() during bootstrap');
    }
    const provider = resolverAssetHubProvider();
    const client = createClient(provider);
    const api = createRawApi(client);

    onPhase?.('asset-hub-syncing');
    onStatus?.('Syncing with Asset Hub Paseo...');
    const syncStart = performance.now();
    let syncMs: number;
    // Assign `clientInstance` / `apiInstance` only AFTER the chain head is
    // ready. If `whenReady` throws, we tear down the local client immediately.
    // Leaving an orphaned client behind would silently keep a smoldot chain
    // subscription alive, and the next `ensureClient()` call would still see
    // `apiInstance === null` and loop on the same dead provider.
    //
    // `whenReady()` resolves on the chainHead `initialized` event, which
    // smoldot can emit from the relay's best block during the optimistic
    // bootstrap window, well before the first real relay finalization.
    //
    // Bound the wait: without it, an unreachable peer set leaves
    // `whenReady()` pending forever and the UI sits on the "Syncing…"
    // overlay indefinitely. The timeout throws so the outer catch can
    // surface a visible error via `showError`.
    try {
      await m.span(S.SMOLDOT_FINALIZED_BLOCK, () =>
        raceSyncTimeout(api.whenReady(), HUB_CHAIN, TIMEOUTS.HUB_FINALIZED_SYNC),
      );
      syncMs = performance.now() - syncStart;
      m.measure(S.SMOLDOT_FINALIZED_BLOCK, syncMs);
      m.distribution(S.SMOLDOT_FINALIZED_BLOCK, syncMs);
    } catch (err) {
      try {
        api.destroy();
        client.destroy();
        // eslint-disable-next-line no-restricted-syntax -- best-effort teardown of a never-fully-initialised client; the real cause is rethrown on the next line.
      } catch {
        /* already dead, real cause rethrown below */
      }
      throw err;
    }

    // If the chainHead follow dies (server emits stop, follow errors, smoldot
    // panics during the optimistic window), invalidate the cached client so
    // the next `ensureClient` redials against a fresh smoldot chain. Without
    // this, every subsequent read returns `null` silently (the "name not
    // found" path) even though the upstream is dead.
    api.onStop(() => {
      log.warn('[dot.li resolve] chainHead follow stopped, invalidating resolver client');
      destroyResolverClient();
    });

    clientInstance = client;
    apiInstance = api;
    outcome = 'ok';
    log.event('Asset Hub client ready', {
      flow: 'resolve',
      sync_ms: Math.round(syncMs),
      total_ms: Math.round(performance.now() - initStart),
    });
    onPhase?.('asset-hub-ready');
    onStatus?.('Connected to Asset Hub Paseo');
    return apiInstance;
  } catch (err) {
    if (err instanceof NetworkSyncTimeoutError) {
      outcome = 'timeout';
    }
    throw err;
  } finally {
    // Recorded here alone: both the SharedWorker's pre-sync and direct mode's
    // first resolution come through this function.
    const totalMs = performance.now() - initStart;
    if (outcome === 'ok') {
      m.measure(S.SMOLDOT_PRESYNC, totalMs);
    }
    m.distribution(S.SMOLDOT_PRESYNC, totalMs, 'millisecond', { outcome });
  }
}

/**
 * Presync primitive used by the SharedWorker / direct-mode bootstrap.
 *
 * The same work that `resolveDotName` does under the hood (spin up
 * smoldot, add relay chain, add Asset Hub, wait for first finalized
 * block), minus the name resolution step. Exposing it as a named
 * function means the protocol-shared-worker can say "I want to be
 * ready" instead of calling `resolveDotName("__presync__")` and
 * relying on the resolver to special-case the sentinel label. The old
 * approach coupled presync to whatever the resolver happened to do
 * with unknown labels. This decouples them.
 */
export async function waitForAssetHubFinalized(onStatus?: StatusCallback, onPhase?: PhaseCallback): Promise<void> {
  await ensureClient({ onStatus, onPhase });
}

// People chain warm-keep for legacy-account auth.
//
// Auth reads the username -> account map on the People chain. On a cold start
// that read races the parachain warp sync, which is the source of the
// intermittent "People read sometimes fails" reports. This mirrors the Asset
// Hub bootstrap above (open a follow, drive it to a finalized block with a
// bounded wait, invalidate on stop, keep the client alive) so the chain is
// already synced when auth connects. The one difference from Asset Hub: this is
// meant to run in the background and must NOT gate the ready signal, because
// resolution does not need People.
let peopleClientInstance: SubstrateClient | null = null;
let peopleApiInstance: Api | null = null;
let peoplePromise: Promise<Api> | null = null;

function destroyPeopleClient(): void {
  peopleApiInstance?.destroy();
  peopleClientInstance?.destroy();
  peopleApiInstance = null;
  peopleClientInstance = null;
  peoplePromise = null;
}

export async function waitForPeopleFinalized(onStatus?: StatusCallback): Promise<void> {
  if (peopleApiInstance) {
    return;
  }
  // Must go through the broker's shared People follow. Without the injected
  // provider we'd have to open our own `getSmProvider` on the shared chain —
  // the dual-follow race this warm-keep was rewritten to avoid — so skip
  // instead. People still resolves on demand via the broker (cold on first
  // use) rather than corrupting the broker's follow stream.
  const peopleProvider = resolverPeopleProvider;
  if (peopleProvider === null) {
    log.debug('[dot.li resolve] People provider not set — skipping warm-keep (resolves on demand via broker)');
    return;
  }
  peoplePromise ??= (async () => {
    const initStart = performance.now();
    onStatus?.('Warming People chain...');
    const provider = peopleProvider();
    const client = createClient(provider);
    const api = createRawApi(client);
    try {
      await raceSyncTimeout(api.whenReady(), 'People Paseo', TIMEOUTS.PEOPLE_FINALIZED_SYNC);
    } catch (err) {
      try {
        api.destroy();
        client.destroy();
        // eslint-disable-next-line no-restricted-syntax -- best-effort teardown of a never-fully-initialised client; the real cause is rethrown on the next line.
      } catch {
        /* already dead, real cause rethrown below */
      }
      peoplePromise = null;
      throw err;
    }

    // If the follow dies, invalidate so the next warm rebuilds against a fresh
    // smoldot chain instead of reusing a dead one.
    api.onStop(() => {
      log.warn('[dot.li resolve] People chainHead follow stopped, invalidating warm client');
      destroyPeopleClient();
    });

    peopleClientInstance = client;
    peopleApiInstance = api;
    log.event('People chain warmed', { flow: 'resolve', ms: Math.round(performance.now() - initStart) });
    return api;
  })();
  await peoplePromise;
}

// The `error.data` the protocol's chain pool puts on its answer to a request
// whose chain halted under it: `CHAIN_HALTED_ERROR_DATA` in
// `packages/protocol/src/chain-halted.ts`. The resolver must not import the
// protocol package, so the value is repeated here.
const CHAIN_HALTED_ERROR_DATA = 'dotli:chain-halted';

/**
 * Whether a read failed because the chain under the resolver's client halted.
 * Each of these comes with the follow's `stop`, which has already dropped the
 * client (through `onStop`, or before its first block by never caching it), so
 * the next attempt takes a fresh lease and the pool rebuilds the chain:
 *
 * - the pool's answer to a request still in flight, marked with
 *   `CHAIN_HALTED_ERROR_DATA` (papi keeps the JSON-RPC `data` on `RpcError`);
 * - `ApiStoppedError` (`api.ts`): the follow stopped before its first block,
 *   or a read started after it stopped;
 * - papi's `DisjointError`: the same `stop` cut off an operation already
 *   running.
 */
function isChainHalt(err: unknown): boolean {
  if (err instanceof RpcError) {
    return err.data === CHAIN_HALTED_ERROR_DATA;
  }
  return err instanceof DisjointError || (err instanceof Error && err.name === 'ApiStoppedError');
}

/**
 * Attempts a read gets on chains that halt under it. A light client resuming
 * from a recent stored database sends `stop` on the follows it opened at the
 * stale head once it catches up, and can do so twice in one catch-up (DOTLI-BY),
 * so one retry is not enough. Bounded so a chain that dies instantly cannot spin
 * a caller without a deadline; one that keeps dying fails its next connect
 * instead, which the protocol context reports as fatal.
 */
const MAX_HALT_ATTEMPTS = 4;

/**
 * Run a read, and again on a rebuilt chain each time its chain halts under it,
 * up to `MAX_HALT_ATTEMPTS`. Every retry gets what is left of the caller's sync
 * budget, not a fresh one.
 */
async function withHaltRetry<T>(opts: ResolveOptions, read: (opts: ResolveOptions) => Promise<T>): Promise<T> {
  const started = performance.now();
  const budget = opts.syncTimeoutMs;
  for (let attempt = 1; ; attempt++) {
    const attemptOpts =
      attempt === 1 || budget === undefined
        ? opts
        : { ...opts, syncTimeoutMs: Math.max(1, Math.floor(budget - (performance.now() - started))) };
    try {
      return await read(attemptOpts);
    } catch (err) {
      if (!isChainHalt(err) || attempt === MAX_HALT_ATTEMPTS) {
        throw err;
      }
      log.warn(
        `[dot.li resolve] Chain halted mid-resolution, retrying on a rebuilt chain (attempt ${String(attempt + 1)}/${String(MAX_HALT_ATTEMPTS)}): ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
}

export function resolveDotName(label: string, opts: ResolveOptions = {}): Promise<string | null> {
  return withHaltRetry(opts, attempt => readDotName(label, attempt));
}

async function readDotName(label: string, opts: ResolveOptions): Promise<string | null> {
  const { onStatus, onPhase } = opts;
  const api = await ensureClient(opts);

  const domain = `${label}.${getActiveServicesConfig().dotns.TLD}`;
  const node = namehash(domain);

  onPhase?.('resolving-content');
  onStatus?.(`Resolving content for ${domain}...`);
  const contentStart = performance.now();

  const dotns = getActiveServicesConfig().dotns;
  const contenthashBytes = await m.span(S.RESOLVE_STORAGE_READ, () =>
    readMappingBytes(api, dotns.DOTNS_CONTENT_RESOLVER, node, dotns.STORAGE_SLOTS.CONTENTHASH),
  );
  const contentMs = performance.now() - contentStart;
  m.measure(S.RESOLVE_STORAGE_READ, contentMs);
  log.event('Contenthash read', { flow: 'resolve', found: contenthashBytes !== null, ms: Math.round(contentMs) });

  if (contenthashBytes === null) {
    onStatus?.(`Domain ${domain} not found or no content set`);
    return null;
  }

  // The contenthash decoder returns a discriminated result so we can tell
  // the user why we failed instead of conflating "no record" / "wrong
  // codec" / "decode error".
  const decoded = decodeIpfsContenthashResult(toHex(contenthashBytes));
  switch (decoded.kind) {
    case 'ok':
      return decoded.cid;
    case 'empty':
      onStatus?.(`Domain ${domain} not found or no content set`);
      return null;
    case 'unsupported-codec':
      throw new UnsupportedContenthashCodecError(domain, decoded.codec);
    case 'decode-error':
      throw new ContenthashDecodeError(domain, decoded.cause);
  }
}

/**
 * Read the executable manifest at `<kind>.<label>.<tld>` over the resolver's
 * shared smoldot client.
 *
 * Returns a discriminated result so the host can distinguish "no manifest",
 * "malformed manifest", and "this network has no manifest support".
 */
export function resolveExecutableManifest(
  label: string,
  kind: ExecutableKind,
  opts: ResolveOptions = {},
): Promise<ManifestResult<ExecutableManifest>> {
  return withHaltRetry(opts, async attempt => {
    const api = await ensureClient(attempt);
    return readExecutableManifest(api, getActiveServicesConfig().dotns, label, kind);
  });
}

/** Smoldot-backed reader for the root manifest at `<label>.<tld>`. */
export function resolveRootManifest(label: string, opts: ResolveOptions = {}): Promise<ManifestResult<RootManifest>> {
  return withHaltRetry(opts, async attempt => {
    const api = await ensureClient(attempt);
    return readRootManifest(api, getActiveServicesConfig().dotns, label);
  });
}

export function resolveOwner(label: string, opts: ResolveOptions = {}): Promise<string | null> {
  return withHaltRetry(opts, attempt => readOwner(label, attempt));
}

async function readOwner(label: string, opts: ResolveOptions): Promise<string | null> {
  const api = await ensureClient(opts);

  const domain = `${label}.${getActiveServicesConfig().dotns.TLD}`;
  const node = namehash(domain);

  const dotns = getActiveServicesConfig().dotns;
  return readMappingAddress(api, dotns.DOTNS_REGISTRY, node, dotns.STORAGE_SLOTS.REGISTRY_RECORDS);
}
