// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li light-client chain provider factory.
//
// Produces `JsonRpcProvider`s backed by @parity/truapi-provider's embedded
// smoldot light client, one instance shared across the resolver, the broker,
// and every dApp connection. Each chain resolves from the genesis hash passed
// to `connect()` through truapi-provider's bundled catalog, which carries the
// chain specs, relay topology, and statement-store placement. Gateway (`rpc`)
// mode dials public nodes through `./rpc-chain.ts` instead.

import type { JsonRpcMessage } from "@polkadot-api/json-rpc-provider";
import type { JsonRpcProvider } from "polkadot-api";
import { getActiveSupportedGenesisHashes } from "@dotli/config/network";
import { log } from "@dotli/shared/log";
import init, {
  ChainProviderBuilder,
  setLogLevel,
  type ChainProviderHandle,
  type Connection,
} from "@parity/truapi-provider";
import wasmUrl from "@parity/truapi-provider/truapi_provider_bg.wasm?url";

// One provider per host process: every connection shares the single embedded
// light client.
let handlePromise: Promise<ChainProviderHandle> | null = null;

function isLocalHost(): boolean {
  const host = globalThis.location.hostname;
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1"
  );
}

// Falls back to "" in contexts that lack `sessionStorage`, such as the shared
// worker, so callers can read a flag without guarding each access.
function sessionFlag(key: string): string {
  const store = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  return store === undefined ? "" : (store.getItem(key) ?? "");
}

// Console verbosity for the embedded provider and smoldot. A `sessionStorage`
// override wins. Otherwise localhost defaults to `info` so the light client is
// observable out of the box, and deployed origins stay silent.
function providerLogLevel(): string {
  const override = sessionFlag("dotli:truapi-provider-log");
  if (override !== "") {
    return override;
  }
  return isLocalHost() ? "info" : "off";
}

function getHandle(): Promise<ChainProviderHandle> {
  handlePromise ??= (async () => {
    await init({ module_or_path: wasmUrl });
    // Route the provider and smoldot `tracing` output to the console, and expose
    // `__truapiProvider.setLogLevel(...)` as a runtime verbosity toggle.
    setLogLevel(providerLogLevel());
    (
      globalThis as unknown as {
        __truapiProvider?: { setLogLevel: (level: string) => void };
      }
    ).__truapiProvider = { setLogLevel };
    const handle = new ChainProviderBuilder().build();
    log.warn("[dot.li provider] truapi-provider ready (embedded smoldot wasm)");
    return handle;
  })().catch((error: unknown) => {
    // Clear the cached promise so the next call retries instead of handing the
    // same dead rejection to every caller forever.
    handlePromise = null;
    throw error;
  });
  return handlePromise;
}

export function isChainSupported(genesisHash: string): boolean {
  return getActiveSupportedGenesisHashes().has(genesisHash.toLowerCase());
}

/**
 * Create a `JsonRpcProvider` for a genesis hash, backed by truapi-provider.
 * Returns `null` for a genesis the active network does not define.
 *
 * papi providers are object-wire; the truapi connection is a raw string pipe,
 * so messages are stringified on send and parsed on receipt. Messages sent
 * before the async connect resolves are queued and flushed in order.
 */
export function createChainProvider(
  genesisHash: string,
): JsonRpcProvider | null {
  const key = genesisHash.toLowerCase();
  if (!isChainSupported(key)) {
    log.warn(`[dot.li provider] Unsupported chain: ${genesisHash}`);
    return null;
  }

  return (onMessage) => {
    // Object-held so control-flow analysis doesn't narrow the flag across the
    // connect await (`disconnect` can flip it at any time).
    const state: { connection: Connection | null; closed: boolean } = {
      connection: null,
      closed: false,
    };
    const queued: string[] = [];

    void (async () => {
      try {
        const handle = await getHandle();
        const candidate = await handle.connect(key);
        if (state.closed) {
          candidate.close();
          return;
        }
        state.connection = candidate;
        for (const message of queued) {
          candidate.send(message);
        }
        queued.length = 0;
        for (;;) {
          const response = await candidate.nextResponse();
          if (response === undefined) {
            break;
          }
          onMessage(JSON.parse(response) as JsonRpcMessage);
        }
      } catch (error) {
        log.error("[dot.li provider] chain connection failed:", error);
      }
    })();

    return {
      send(message) {
        if (state.closed) {
          return;
        }
        const raw = JSON.stringify(message);
        if (state.connection !== null) {
          state.connection.send(raw);
        } else {
          queued.push(raw);
        }
      },
      disconnect() {
        state.closed = true;
        state.connection?.close();
        state.connection = null;
      },
    };
  };
}
