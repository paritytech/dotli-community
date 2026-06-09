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

import {
  createClient,
  type SubstrateClient,
} from "@polkadot-api/substrate-client";
import { getWsProvider } from "polkadot-api/ws";
import { TIMEOUTS } from "@dotli/config/config";
import { getActiveServicesConfig } from "@dotli/config/network";
import { log } from "@dotli/shared/log";
import { dur } from "@dotli/shared/perf";
import { namehash, toHex, decodeIpfsContenthashResult } from "./abi";
import {
  ContenthashDecodeError,
  NetworkSyncTimeoutError,
  UnsupportedContenthashCodecError,
} from "./errors";
import { readMappingBytes, readMappingAddress } from "./access-raw-storage";
import type { StatusCallback } from "./access-raw-storage";
import { createRawApi, type Api } from "./api";
import { readExecutableManifest, readRootManifest } from "./manifest";
import type {
  ExecutableKind,
  ExecutableManifest,
  ManifestResult,
  RootManifest,
} from "./manifest";

export type { StatusCallback } from "./access-raw-storage";

/**
 * `WsJsonRpcProvider` from `polkadot-api/ws-provider`. Its type is not
 * re-exported from the top-level entry point, so we derive it here.
 * Gives us `.getStatus()` which returns `{ type: "CONNECTED"|..., uri }`
 * so callers can read which node we actually dialed (the round-robin
 * rotates on failure, so the first entry of the candidate list may not
 * be the currently answering endpoint).
 */
type WsProviderHandle = ReturnType<typeof getWsProvider>;

let clientInstance: SubstrateClient | null = null;
let apiInstance: Api | null = null;
let clientPromise: Promise<Api> | null = null;
let providerInstance: WsProviderHandle | null = null;

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
  const provider = getWsProvider([...getActiveServicesConfig().assethub.rpcs], {
    // Public RPC endpoints can be tunnel-gated. The default 40s heartbeat
    // is occasionally too tight.
    heartbeatTimeout: 120_000,
  });
  providerInstance = provider;

  const client = createClient(provider);
  const api = createRawApi(client);

  // Bound the wait: without the race, an unreachable peer set leaves
  // `whenReady()` pending forever and the UI sits on "Connecting…"
  // indefinitely. The timeout throws so the outer catch can surface a
  // visible error via `showError`. Mirrors the smoldot path at
  // `resolve.ts:170-185`.
  try {
    await Promise.race([
      api.whenReady(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new NetworkSyncTimeoutError(
              "Asset Hub RPC",
              TIMEOUTS.ASSET_HUB_FINALIZED_SYNC,
            ),
          );
        }, TIMEOUTS.ASSET_HUB_FINALIZED_SYNC);
      }),
    ]);
    log.warn(`[dot.li rpc-resolve] RPC chain head ready (${dur(t0)})`);
  } catch (err) {
    try {
      api.destroy();
      client.destroy();
      // eslint-disable-next-line no-restricted-syntax -- best-effort teardown of a never-fully-initialised client; the real cause is rethrown on the next line.
    } catch {
      /* already dead */
    }
    log.error(
      `[dot.li rpc-resolve] RPC connection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    providerInstance = null;
    throw err;
  }

  // If the chainHead follow dies (server emits stop, follow errors, WS
  // disconnect), invalidate the cached client so the next `ensureClient`
  // redials. Without this, every subsequent read returns `null` silently
  // (the "name not found" path) even though the upstream is dead.
  api.onStop(() => {
    log.warn(
      "[dot.li rpc-resolve] chainHead follow stopped, invalidating RPC client",
    );
    destroyRpcClient();
  });

  clientInstance = client;
  apiInstance = api;
  onStatus?.("Connected to Asset Hub RPC");
  return apiInstance;
}

/**
 * Resolve a `.dot` label to an IPFS CID by reading dotNS contract storage
 * directly over JSON-RPC (bypassing smoldot).
 *
 * This is the "trusted gateway" path: a normal client-server request to
 * a known Polkadot RPC node instead of running a light client in-browser.
 */
export async function resolveDotNameViaRpc(
  label: string,
  onStatus?: StatusCallback,
): Promise<string | null> {
  log.warn(
    `[dot.li rpc-resolve] resolving ${label}.dot via JSON-RPC (trusted node, smoldot bypassed)`,
  );
  const api = await ensureClient(onStatus);

  const domain = `${label}.dot`;
  const node = namehash(domain);

  onStatus?.(`Resolving "${domain}" via Trusted Provider...`);
  const t0 = performance.now();

  const dotns = getActiveServicesConfig().dotns;
  const contenthashBytes = await readMappingBytes(
    api,
    dotns.DOTNS_CONTENT_RESOLVER,
    node,
    dotns.storageSlots.CONTENTHASH,
  );

  log.warn(
    `[dot.li rpc-resolve] chainHead storage contenthash for ${domain}: ${dur(t0)}`,
  );

  if (contenthashBytes === null) {
    onStatus?.(`Domain "${domain}" not found or no content set`);
    return null;
  }

  // Mirror the smoldot-side resolver in distinguishing "not registered" /
  // "non-IPFS contenthash" / "decode error".
  const decoded = decodeIpfsContenthashResult(toHex(contenthashBytes));
  switch (decoded.kind) {
    case "ok":
      log.warn(
        `[dot.li rpc-resolve] resolved ${domain} -> ${decoded.cid} (${dur(t0)})`,
      );
      onStatus?.(`Resolved "${domain}" via Trusted Provider`);
      return decoded.cid;
    case "empty":
      onStatus?.(`Domain "${domain}" not found or no content set`);
      return null;
    case "unsupported-codec":
      throw new UnsupportedContenthashCodecError(domain, decoded.codec);
    case "decode-error":
      throw new ContenthashDecodeError(domain, decoded.cause);
  }
}

/**
 * Read the executable manifest at `<kind>.<label>.dot` over the gateway
 * RPC client.
 *
 * The return shape matches the smoldot path so the host shell can branch
 * on a single discriminated union regardless of backend.
 */
export async function resolveExecutableManifestViaRpc(
  label: string,
  kind: ExecutableKind,
): Promise<ManifestResult<ExecutableManifest>> {
  const api = await ensureClient();
  const dotns = getActiveServicesConfig().dotns;
  return readExecutableManifest(api, dotns, label, kind);
}

/** Gateway-backed reader for the root manifest at `<label>.dot`. */
export async function resolveRootManifestViaRpc(
  label: string,
): Promise<ManifestResult<RootManifest>> {
  const api = await ensureClient();
  const dotns = getActiveServicesConfig().dotns;
  return readRootManifest(api, dotns, label);
}

/**
 * Resolve the owner address of a `.dot` label by reading the dotNS registry
 * contract storage over JSON-RPC.
 */
export async function resolveOwnerViaRpc(
  label: string,
): Promise<string | null> {
  const api = await ensureClient();

  const domain = `${label}.dot`;
  const node = namehash(domain);

  const dotns = getActiveServicesConfig().dotns;
  return readMappingAddress(
    api,
    dotns.DOTNS_REGISTRY,
    node,
    dotns.storageSlots.REGISTRY_RECORDS,
  );
}

/**
 * Return the Asset Hub RPC endpoint URI the shared ws-provider is
 * currently dialing, or `null` when no client has been instantiated
 * yet. The URI may not be the first entry of the candidate list,
 * because polkadot-api's ws-provider rotates on failure. Callers that
 * want to display which node is actually answering (e.g. the
 * diagnostics popover) should read this instead of the config list.
 *
 * Returns `null` while in CONNECTING / ERROR / CLOSE states too, so
 * the caller can decide whether to fall back to a placeholder.
 */
export function getConnectedAssetHubRpcEndpoint(): string | null {
  if (providerInstance === null) {
    return null;
  }
  const status = providerInstance.getStatus();
  // Discriminated union: the CONNECTED and CONNECTING variants carry a
  // `uri` field, ERROR and CLOSE don't. `"uri" in status` is the
  // narrowing path that doesn't require importing the `WsEvent` enum.
  // We surface CONNECTING too so the popover shows the URI the provider
  // is currently trying, not a stale "n/a" during transient reconnects.
  if ("uri" in status) {
    return status.uri;
  }
  return null;
}

/**
 * Tear down the RPC client. Safe to call multiple times. Must be invoked
 * by the network-switch handler so a stale follow against the old network's
 * endpoint can't satisfy reads against the new network's config.
 */
export function destroyRpcClient(): void {
  if (clientInstance !== null) {
    try {
      apiInstance?.destroy();
      clientInstance.destroy();
      // eslint-disable-next-line no-restricted-syntax -- best-effort teardown: the WS client may already be disconnected; we still clear references below.
    } catch {
      /* already dead */
    }
    clientInstance = null;
    apiInstance = null;
    providerInstance = null;
  }
}
