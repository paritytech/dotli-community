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
import { raceSyncTimeout } from './sync-deadline.js';
import { readMappingBytes, readMappingAddress } from './access-raw-storage.js';
import type { StatusCallback } from './access-raw-storage.js';
import { createRawApi, type Api } from './api.js';
import { getConnectedRpcEndpoint } from './rpc-chain.js';
import { readExecutableManifest, readRootManifest } from './manifest.js';
import type { ExecutableKind, ExecutableManifest, ManifestResult, RootManifest } from './manifest.js';

export type { StatusCallback } from './access-raw-storage.js';

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
  clientPromise = doCreateClient(onStatus).finally(() => {
    clientPromise = null;
  });
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

  // A dead follow would otherwise make every later read return `null`, which reads as "name not found".
  api.onStop(() => {
    log.warn('[dot.li rpc-resolve] chainHead follow stopped, invalidating RPC client');
    destroyRpcClient();
  });

  clientInstance = client;
  apiInstance = api;
  onStatus?.('Connected to Asset Hub RPC');
  return apiInstance;
}

export async function resolveDotNameViaRpc(label: string, onStatus?: StatusCallback): Promise<string | null> {
  const api = await ensureClient(onStatus);

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
}

export async function resolveExecutableManifestViaRpc(
  label: string,
  kind: ExecutableKind,
): Promise<ManifestResult<ExecutableManifest>> {
  const api = await ensureClient();
  const dotns = getActiveServicesConfig().dotns;
  return readExecutableManifest(api, dotns, label, kind);
}

export async function resolveRootManifestViaRpc(label: string): Promise<ManifestResult<RootManifest>> {
  const api = await ensureClient();
  const dotns = getActiveServicesConfig().dotns;
  return readRootManifest(api, dotns, label);
}

export async function resolveOwnerViaRpc(label: string): Promise<string | null> {
  const api = await ensureClient();

  const domain = `${label}.${getActiveServicesConfig().dotns.TLD}`;
  const node = namehash(domain);

  const dotns = getActiveServicesConfig().dotns;
  return readMappingAddress(api, dotns.DOTNS_REGISTRY, node, dotns.STORAGE_SLOTS.REGISTRY_RECORDS);
}

/** The node actually answering, which may not be the first configured one, since the transport rotates. */
export function getConnectedAssetHubRpcEndpoint(): string | null {
  return getConnectedRpcEndpoint(getActiveServicesConfig().assethub.genesis);
}

/** Idempotent. A network switch must call it, so the old network's follow cannot answer new reads. */
export function destroyRpcClient(): void {
  if (clientInstance !== null) {
    try {
      apiInstance?.destroy();
      clientInstance.destroy();
      // eslint-disable-next-line no-restricted-syntax -- the socket may already be gone, and the references below must still clear.
    } catch {
      /* already dead */
    }
    clientInstance = null;
    apiInstance = null;
  }
}
