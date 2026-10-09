// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dotNS resolution over a trusted Asset Hub RPC node. Never imports smoldot, so the light client stays
// out of any bundle that only pulls this module.

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { createClient, type SubstrateClient } from '@polkadot-api/substrate-client';

import { TIMEOUTS, getActiveServicesConfig } from '@dotli/config';

import { log } from '@dotli/shared';

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

/** The host injects a lease on its chain pool, which the resolver cannot import. */
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

  // Bounded, since an unreachable node leaves `whenReady()` pending forever. With no caller deadline here,
  // the 90s protocol request timer still wins and the host reports the generic message.
  try {
    await raceSyncTimeout(api.whenReady(), 'Asset Hub RPC', TIMEOUTS.HUB_FINALIZED_SYNC);
    log.event('RPC chain head ready', { flow: 'resolve', ms: Math.round(performance.now() - t0) });
  } catch (err) {
    try {
      api.destroy();
      client.destroy();
      // eslint-disable-next-line no-restricted-syntax -- best-effort teardown of a never-fully-initialised client, the real cause is rethrown below.
    } catch {
      /* already dead */
    }
    log.error(`[dot.li rpc-resolve] RPC connection failed: ${err instanceof Error ? err.message : String(err)}`, err);
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

export function resolveDotNameViaRpc(label: string, onStatus?: StatusCallback): Promise<string | null> {
  return withRpcClient(async api => {
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

    log.event('Contenthash read', {
      flow: 'resolve',
      found: contenthashBytes !== null,
      ms: Math.round(performance.now() - t0),
    });

    if (contenthashBytes === null) {
      onStatus?.(`Domain "${domain}" not found or no content set`);
      return null;
    }

    // Mirror the smoldot-side resolver in distinguishing "not registered" /
    // "non-IPFS contenthash" / "decode error".
    const decoded = decodeIpfsContenthashResult(toHex(contenthashBytes));
    switch (decoded.kind) {
      case 'ok':
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

export function resolveExecutableManifestViaRpc(
  label: string,
  kind: ExecutableKind,
): Promise<ManifestResult<ExecutableManifest>> {
  return withRpcClient(api => {
    const dotns = getActiveServicesConfig().dotns;
    return readExecutableManifest(api, dotns, label, kind);
  });
}

export function resolveRootManifestViaRpc(label: string): Promise<ManifestResult<RootManifest>> {
  return withRpcClient(api => {
    const dotns = getActiveServicesConfig().dotns;
    return readRootManifest(api, dotns, label);
  });
}

export function resolveOwnerViaRpc(label: string): Promise<string | null> {
  return withRpcClient(api => {
    const domain = `${label}.${getActiveServicesConfig().dotns.TLD}`;
    const node = namehash(domain);

    const dotns = getActiveServicesConfig().dotns;
    return readMappingAddress(api, dotns.DOTNS_REGISTRY, node, dotns.STORAGE_SLOTS.REGISTRY_RECORDS);
  });
}

/** The node actually answering, which may not be the first configured one, since the transport rotates. */
export function getConnectedAssetHubRpcEndpoint(): string | null {
  return getConnectedRpcEndpoint(getActiveServicesConfig().assethub.genesis);
}

/** Idempotent. A network switch must call it, so the old network's follow cannot answer new reads. */
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
