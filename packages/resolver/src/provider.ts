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
// Import via the package specifier, not a relative path. `prodNoAnalyticsAliases`
// rewrites `@dotli/metrics/metrics` to the no-op at bundle time, and a relative
// import would slip past that and pull real metrics into a stripped build.
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { log } from "@dotli/shared/log";
import init, {
  ChainProviderBuilder,
  setLogLevel,
  type ChainProviderHandle,
  type Connection,
} from "@parity/truapi-provider";
import wasmUrl from "@parity/truapi-provider/truapi_provider_bg.wasm?url";
import { createSmoldotDb } from "./smoldot-db";

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

const HEARTBEAT_DEFAULT_MS = 60_000;

// A `sessionStorage` override, same shape as `dotli:truapi-provider-log` above.
// Tests set it high so only the startup emission lands inside the run, which is
// what makes the emitted count exact rather than a function of wall-clock.
function heartbeatIntervalMs(): number {
  const override = Number(sessionFlag("dotli:smoldot-heartbeat-ms"));
  return Number.isFinite(override) && override > 0
    ? override
    : HEARTBEAT_DEFAULT_MS;
}

/**
 * Report that a light client is alive in this context, once now and then on
 * every tick.
 *
 * The immediate emission matters twice over. It keeps the first bucket from
 * reading as zero while the client is already syncing, and it means a context
 * contributes exactly one point from the moment it exists, so a reader counting
 * startup points counts contexts.
 *
 * Deliberately not paired with a teardown call. `handlePromise` lives as long
 * as the context does and nothing runs when a tab or worker is killed, so a
 * stop function exists for tests rather than for production shutdown.
 */
export function startLightClientHeartbeat(
  intervalMs: number = heartbeatIntervalMs(),
): () => void {
  // A metrics-stripped build drops every gauge on the floor, and the timer on
  // its own is not free: a pending interval is a live task that can keep an
  // otherwise idle SharedWorker from being reclaimed.
  if (!m.enabled) {
    return () => {
      /* nothing started */
    };
  }
  m.gauge(S.SMOLDOT_ACTIVE, 1);
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    m.gauge(S.SMOLDOT_ACTIVE, 1);
  }, intervalMs);
  return () => {
    clearInterval(timer);
  };
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
    const builder = new ChainProviderBuilder();
    const store = createSmoldotDb();
    if (store !== null) {
      builder.setStorage(store);
    }
    const handle = builder.build();
    // Inside `getHandle`, so the heartbeat is scoped to the singleton rather
    // than to callers. One context means one client means one emitter, whether
    // that context is the SharedWorker serving every tab or a per-tab iframe.
    startLightClientHeartbeat();
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

// A connection that ends without `disconnect()` leaves every in-flight
// request on that chain waiting forever: papi has no error channel on a
// `JsonRpcProvider`, so a half-open transport is indistinguishable from a
// quiet one. Surface it here and let the protocol layer reject pending work
// the way the smoldot panic broadcast used to.
type FatalCallback = (message: string) => void;
const fatalListeners = new Set<FatalCallback>();
let fatalMessage: string | null = null;

export function onProviderFatal(cb: FatalCallback): () => void {
  fatalListeners.add(cb);
  // Replay for listeners registered after the failure so a late subscriber
  // still sees it instead of waiting on a chain that is already gone.
  if (fatalMessage !== null) {
    try {
      cb(fatalMessage);
      // eslint-disable-next-line no-restricted-syntax -- defensive multicast replay: one buggy late subscriber must not prevent the caller from registering.
    } catch {
      /* listener threw, safe to ignore on replay */
    }
  }
  return () => {
    fatalListeners.delete(cb);
  };
}

function markFatal(message: string): void {
  if (fatalMessage !== null) {
    return;
  }
  fatalMessage = message;
  log.error(`[dot.li provider] ${message}`);
  for (const cb of fatalListeners) {
    try {
      cb(message);
      // eslint-disable-next-line no-restricted-syntax -- defensive multicast: one buggy subscriber must not block the broadcast to all others.
    } catch {
      /* listener threw, do not let one listener break the broadcast */
    }
  }
}

export function isChainSupported(genesisHash: string): boolean {
  return getActiveSupportedGenesisHashes().has(genesisHash.toLowerCase());
}

async function resumeFromStore(
  handle: ChainProviderHandle,
  key: string,
): Promise<void> {
  try {
    if (await handle.loadDatabase(key)) {
      log.debug(`[dot.li provider] resuming ${key} from stored state`);
    }
  } catch (error) {
    // Never block the connection on the store. Syncing from the chain-spec
    // checkpoint is slower but correct.
    log.warn(`[dot.li provider] warm start unavailable for ${key}:`, error);
  }
}

/**
 * Create a `JsonRpcProvider` for a genesis hash, backed by truapi-provider.
 * Returns `null` for a genesis the active network does not define.
 *
 * papi providers are object-wire. The truapi connection is a raw string pipe,
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
    // Read through a call so the early `state.closed` guard below does not
    // narrow later reads to `false`. `disconnect` mutates it between awaits,
    // which control-flow analysis cannot see.
    const isClosed = (): boolean => state.closed;
    const queued: string[] = [];

    void (async () => {
      try {
        const handle = await getHandle();
        // Must precede `connect`: only a chain's first add consumes a blob.
        await resumeFromStore(handle, key);
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
            // Only `disconnect()` makes this an orderly end. Otherwise the
            // transport died or overflowed its send budget, and no further
            // response will ever arrive on this chain.
            if (!isClosed()) {
              markFatal(`chain ${key} stopped responding`);
            }
            break;
          }
          onMessage(JSON.parse(response) as JsonRpcMessage);
        }
      } catch (error) {
        markFatal(
          `chain ${key} connection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
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
