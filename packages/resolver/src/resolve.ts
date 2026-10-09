// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

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

export interface ResolveOptions {
  onStatus?: StatusCallback | undefined;
  onPhase?: PhaseCallback | undefined;
  /** What is left of the caller's deadline, if it set one. */
  syncTimeoutMs?: number;
}

let clientInstance: SubstrateClient | null = null;
let apiInstance: Api | null = null;
let clientPromise: Promise<Api> | null = null;

// Injected by the host so the resolver shares the broker's single Asset Hub follow.
let resolverAssetHubProvider: (() => JsonRpcProvider) | null = null;

export function setResolverAssetHubProvider(factory: (() => JsonRpcProvider) | null): void {
  resolverAssetHubProvider = factory;
}

// Injected by the host so the warm-keep shares the broker's People follow. A second follow on the same
// smoldot chain shares its one response queue, so the broker would drop its events and reads would hang.
let resolverPeopleProvider: (() => JsonRpcProvider) | null = null;

export function setResolverPeopleProvider(factory: (() => JsonRpcProvider) | null): void {
  resolverPeopleProvider = factory;
}

/** The next resolution rebuilds against a fresh client. */
export function destroyResolverClient(): void {
  if (clientInstance !== null) {
    log.event('Resolver client destroyed', { flow: 'resolve' });
    try {
      apiInstance?.destroy();
      clientInstance.destroy();
      // eslint-disable-next-line no-restricted-syntax -- a panicked smoldot may throw here, and the references below must still clear.
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
    // A late subscriber still needs the terminal phase.
    opts.onPhase?.('asset-hub-ready');
    return Promise.resolve(apiInstance);
  }
  // The shared client keeps the full budget, so a short caller cannot cut short a longer one.
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
    // Cached only once ready, and torn down on failure, so no orphaned client keeps a subscription alive.
    // The wait is bounded, since an unreachable peer set leaves `whenReady()` pending forever.
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
        // eslint-disable-next-line no-restricted-syntax -- best-effort teardown of a never-fully-initialised client, the real cause is rethrown on the next line.
      } catch {
        /* already dead, real cause rethrown below */
      }
      throw err;
    }

    // A dead follow would otherwise make every later read return `null`, which reads as "name not found".
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
    // Recorded here alone, since the SharedWorker presync and direct mode both come through here.
    const totalMs = performance.now() - initStart;
    if (outcome === 'ok') {
      m.measure(S.SMOLDOT_PRESYNC, totalMs);
    }
    m.distribution(S.SMOLDOT_PRESYNC, totalMs, 'millisecond', { outcome });
  }
}

/** Presync, the client setup of `resolveDotName` without the name read. */
export async function waitForAssetHubFinalized(onStatus?: StatusCallback, onPhase?: PhaseCallback): Promise<void> {
  await ensureClient({ onStatus, onPhase });
}

// Keeps People synced for legacy-account auth, whose cold read would race the warp sync.
// Runs in the background and must not gate ready, since resolution never needs People.
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
  // Without the broker's provider, a follow of our own would corrupt the broker's stream, so skip.
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
        // eslint-disable-next-line no-restricted-syntax -- best-effort teardown of a never-fully-initialised client, the real cause is rethrown on the next line.
      } catch {
        /* already dead, real cause rethrown below */
      }
      peoplePromise = null;
      throw err;
    }

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

// Repeats `CHAIN_HALTED_ERROR_DATA` from `@dotli/protocol`, which the resolver must not import.
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

/** Every retry gets what is left of the caller's budget, not a fresh one. */
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
