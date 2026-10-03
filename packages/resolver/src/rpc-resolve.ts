// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Trusted RPC-based dotNS resolver.
//
// Reads the dotNS contract storage directly from a public Asset Hub Paseo
// RPC node over WSS JSON-RPC.
//
// The reader is the same `createRawApi(client)` used by the smoldot
// path. It opens a `chainHead_v1_follow` (no metadata fetch) and reads
// `Revive::AccountInfoOf` then the contract's child trie directly. The old
// `getFinalizedBlock()` warmup that forced a metadata exchange we never
// used is gone, and so is the per-read-site runtime-call adapter.
//
// Intentionally does NOT import from `./smoldot` so Vite can tree-shake the
// smoldot worker out of any bundle that only pulls in this module.

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { createClient, type SubstrateClient } from '@polkadot-api/substrate-client';

import { TIMEOUTS, getActiveServicesConfig } from '@dotli/config';

import { log, dur } from '@dotli/shared';

import { namehash, toHex, decodeIpfsContenthashResult } from './abi.js';
import { ContenthashDecodeError, UnsupportedContenthashCodecError } from './errors.js';
import { raceSyncTimeout, withHaltRetry, withSyncBudget } from './sync-deadline.js';
import { readMappingBytes, readMappingAddress } from './access-raw-storage.js';
import type { StatusCallback } from './access-raw-storage.js';
import { createRawApi, type Api } from './api.js';
import { getConnectedRpcEndpoint } from './rpc-chain.js';
import { readExecutableManifest, readRootManifest } from './manifest.js';
import type { ExecutableKind, ExecutableManifest, ManifestResult, RootManifest } from './manifest.js';

export type { StatusCallback } from './access-raw-storage.js';

const RPC_SYNC_OPTIONS = { syncTimeoutMs: TIMEOUTS.HUB_FINALIZED_SYNC };

/** Share the light-client recovery policy without importing its runtime. */
function withRpcClient<T>(read: (api: Api) => Promise<T>, onStatus?: StatusCallback): Promise<T> {
  return withHaltRetry(RPC_SYNC_OPTIONS, async attempt => {
    const api = await withSyncBudget(
      ensureClient(onStatus),
      'Asset Hub RPC',
      attempt.syncTimeoutMs,
      TIMEOUTS.HUB_FINALIZED_SYNC,
    );
    return read(api);
  });
}

let assetHubProviderFactory: (() => JsonRpcProvider) | null = null;

/**
 * Install the factory that opens a connection to Asset Hub. The resolver
 * cannot import the host's chain pool, so the host injects a lease on it
 * (mirrors `setResolverAssetHubProvider` in `resolve.ts`). Each client takes
 * a fresh provider from it, and tearing the client down releases it.
 */
export function setRpcAssetHubProvider(factory: () => JsonRpcProvider): void {
  assetHubProviderFactory = factory;
}

let clientInstance: SubstrateClient | null = null;
let apiInstance: Api | null = null;
let clientPromise: Promise<Api> | null = null;

function ensureClient(onStatus?: StatusCallback): Promise<Api> {
  if (apiInstance !== null) {
    return Promise.resolve(apiInstance);
  }
  if (clientPromise !== null) {
    return clientPromise;
  }
  const creating = doCreateClient(onStatus).finally(() => {
    if (clientPromise === creating) {
      clientPromise = null;
    }
  });
  clientPromise = creating;
  return clientPromise;
}

async function doCreateClient(onStatus?: StatusCallback): Promise<Api> {
  const t0 = performance.now();
  onStatus?.(`Connecting to Asset Hub RPC...`);
  if (assetHubProviderFactory === null) {
    throw new Error('No Asset Hub provider for RPC resolution');
  }
  const provider = assetHubProviderFactory();

  const client = createClient(provider);
  const api = createRawApi(client);

  // Bound the wait: without it, an unreachable peer set leaves
  // `whenReady()` pending forever and the UI sits on "Connecting…"
  // indefinitely. The timeout throws so the outer catch can surface a
  // visible error via `showError`. Mirrors the smoldot path in `resolve.ts`.
  //
  // Unlike the smoldot path this gets no caller deadline, so the 90s protocol
  // request timer still wins and the host reports the generic message.
  try {
    await raceSyncTimeout(api.whenReady(), 'Asset Hub RPC', TIMEOUTS.HUB_FINALIZED_SYNC);
    log.warn(`[dot.li rpc-resolve] RPC chain head ready (${dur(t0)})`);
  } catch (err) {
    try {
      api.destroy();
      client.destroy();
      // eslint-disable-next-line no-restricted-syntax -- best-effort teardown of a never-fully-initialised client; the real cause is rethrown on the next line.
    } catch {
      /* already dead */
    }
    log.error(`[dot.li rpc-resolve] RPC connection failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  // If the chainHead follow dies (server emits stop, follow errors, WS
  // disconnect), invalidate the cached client so the next `ensureClient`
  // redials. Without this, every subsequent read returns `null` silently
  // (the "name not found" path) even though the upstream is dead.
  clientInstance = client;
  apiInstance = api;
  api.onStop(() => {
    if (apiInstance !== api) {
      return;
    }
    log.warn('[dot.li rpc-resolve] chainHead follow stopped, invalidating RPC client');
    destroyRpcClient();
  });
  await api.whenReady();

  onStatus?.('Connected to Asset Hub RPC');
  return api;
}

/**
 * Resolve a `.dot` label to an IPFS CID by reading dotNS contract storage
 * directly over JSON-RPC (bypassing smoldot).
 *
 * This is the "trusted gateway" path: a normal client-server request to
 * a known Polkadot RPC node instead of running a light client in-browser.
 */
export function resolveDotNameViaRpc(label: string, onStatus?: StatusCallback): Promise<string | null> {
  return withRpcClient(async api => {
    log.warn(
      `[dot.li rpc-resolve] resolving ${label}.${getActiveServicesConfig().dotns.TLD} via JSON-RPC (trusted node, smoldot bypassed)`,
    );

    const domain = `${label}.${getActiveServicesConfig().dotns.TLD}`;
    const node = namehash(domain);

    onStatus?.(`Resolving "${domain}" via Trusted Provider...`);
    const t0 = performance.now();

    const dotns = getActiveServicesConfig().dotns;
    const contenthashBytes = await readMappingBytes(
      api,
      dotns.DOTNS_CONTENT_RESOLVER,
      node,
      dotns.STORAGE_SLOTS.CONTENTHASH,
    );

    log.warn(`[dot.li rpc-resolve] chainHead storage contenthash for ${domain}: ${dur(t0)}`);

    if (contenthashBytes === null) {
      onStatus?.(`Domain "${domain}" not found or no content set`);
      return null;
    }

    // Mirror the smoldot-side resolver in distinguishing "not registered" /
    // "non-IPFS contenthash" / "decode error".
    const decoded = decodeIpfsContenthashResult(toHex(contenthashBytes));
    switch (decoded.kind) {
      case 'ok':
        log.warn(`[dot.li rpc-resolve] resolved ${domain} -> ${decoded.cid} (${dur(t0)})`);
        onStatus?.(`Resolved "${domain}" via Trusted Provider`);
        return decoded.cid;
      case 'empty':
        onStatus?.(`Domain "${domain}" not found or no content set`);
        return null;
      case 'unsupported-codec':
        throw new UnsupportedContenthashCodecError(domain, decoded.codec);
      case 'decode-error':
        throw new ContenthashDecodeError(domain, decoded.cause);
    }
  }, onStatus);
}

/**
 * Read the executable manifest at `<kind>.<label>.<tld>` over the gateway
 * RPC client.
 *
 * The return shape matches the smoldot path so the host shell can branch
 * on a single discriminated union regardless of backend.
 */
export function resolveExecutableManifestViaRpc(
  label: string,
  kind: ExecutableKind,
): Promise<ManifestResult<ExecutableManifest>> {
  return withRpcClient(api => {
    const dotns = getActiveServicesConfig().dotns;
    return readExecutableManifest(api, dotns, label, kind);
  });
}

/** Gateway-backed reader for the root manifest at `<label>.<tld>`. */
export function resolveRootManifestViaRpc(label: string): Promise<ManifestResult<RootManifest>> {
  return withRpcClient(api => {
    const dotns = getActiveServicesConfig().dotns;
    return readRootManifest(api, dotns, label);
  });
}

/**
 * Resolve the owner address of a `.dot` label by reading the dotNS registry
 * contract storage over JSON-RPC.
 */
export function resolveOwnerViaRpc(label: string): Promise<string | null> {
  return withRpcClient(api => {
    const domain = `${label}.${getActiveServicesConfig().dotns.TLD}`;
    const node = namehash(domain);

    const dotns = getActiveServicesConfig().dotns;
    return readMappingAddress(api, dotns.DOTNS_REGISTRY, node, dotns.STORAGE_SLOTS.REGISTRY_RECORDS);
  });
}

/**
 * Return the Asset Hub RPC endpoint URI the shared chain connection is
 * currently on, or `null` while none is open. The URI may not be the first
 * entry of the candidate list, because the transport rotates on failure.
 * Callers that want to display which node is actually answering (e.g. the
 * diagnostics popover) should read this instead of the config list.
 */
export function getConnectedAssetHubRpcEndpoint(): string | null {
  return getConnectedRpcEndpoint(getActiveServicesConfig().assethub.genesis);
}

/**
 * Tear down the RPC client. Safe to call multiple times. Must be invoked
 * by the network-switch handler so a stale follow against the old network's
 * endpoint can't satisfy reads against the new network's config.
 */
export function destroyRpcClient(): void {
  const api = apiInstance;
  const client = clientInstance;
  clientInstance = null;
  apiInstance = null;
  clientPromise = null;

  if (client !== null) {
    try {
      api?.destroy();
      client.destroy();
      // eslint-disable-next-line no-restricted-syntax -- teardown can race a dead transport; cached references were cleared before notifying onStop.
    } catch {
      /* already dead */
    }
  }
}
