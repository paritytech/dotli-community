// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// `JsonRpcProvider`s over truapi-provider's embedded smoldot, one instance shared by the resolver, the broker
// and every product. Each chain comes from its genesis hash through truapi-provider's bundled catalog.

import type { JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import type { JsonRpcProvider } from 'polkadot-api';
import { getActiveServicesConfig, getActiveSupportedGenesisHashes } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import init, {
  ChainProviderBuilder,
  setLogLevel,
  type ChainProviderHandle,
  type Connection,
} from '@parity/truapi-provider';
import wasmUrl from '@parity/truapi-provider/truapi_provider_bg.wasm?url';
import { createSmoldotDb } from './smoldot-db.js';
import { attachChainSync, chainKeyForGenesis, reportDbCache, type ChainSyncTap } from './chain-sync.js';
import type { ChainTransportHooks } from './transport-hooks.js';

let handlePromise: Promise<ChainProviderHandle> | null = null;

function isLocalHost(): boolean {
  const host = globalThis.location.hostname;
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1';
}

// "" where `sessionStorage` is missing, such as the SharedWorker.
function sessionFlag(key: string): string {
  const store = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  return store === undefined ? '' : (store.getItem(key) ?? '');
}

function providerLogLevel(): string {
  const override = sessionFlag('dotli:truapi-provider-log');
  if (override !== '') {
    return override;
  }
  return isLocalHost() ? 'info' : 'off';
}

const HEARTBEAT_DEFAULT_MS = 60_000;

// Tests set it high so only the startup emission lands, keeping the count independent of wall-clock.
function heartbeatIntervalMs(): number {
  const override = Number(sessionFlag('dotli:smoldot-heartbeat-ms'));
  return Number.isFinite(override) && override > 0 ? override : HEARTBEAT_DEFAULT_MS;
}

/**
 * Report a live light client now and on every tick, so counting startup points counts contexts.
 * The stop function is for tests, since nothing runs when a tab or worker is killed.
 */
export function startLightClientHeartbeat(intervalMs: number = heartbeatIntervalMs()): () => void {
  // A pending interval can keep an idle SharedWorker from being reclaimed, so skip it when gauges go nowhere.
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
    setLogLevel(providerLogLevel());
    (
      globalThis as unknown as {
        __truapiProvider?: { setLogLevel: (level: string) => void };
      }
    ).__truapiProvider = { setLogLevel };
    const builder = new ChainProviderBuilder();
    // Over https the browser blocks `ws://` to non-localhost peers as mixed content.
    builder.setConnectionTypes({ unsecure: false });
    const store = createSmoldotDb();
    if (store !== null) {
      // The relay's blob is only read here, never through `loadDatabase`. A failure must reject, not read as empty.
      const observed: typeof store = {
        load: async genesisHash => {
          try {
            const blob = await store.load(genesisHash);
            markSmoldotDb(genesisHash, blob !== null ? 'hit' : 'miss');
            return blob;
          } catch (error) {
            markSmoldotDb(genesisHash, 'unavailable');
            throw error;
          }
        },
        save: (genesisHash, blob) => store.save(genesisHash, blob),
      };
      builder.setStorage(observed);
    }
    const handle = builder.build();
    // Scoped to the singleton, so each context has exactly one emitter.
    startLightClientHeartbeat();
    log.event('Light client ready', { flow: 'protocol' });
    return handle;
  })().catch((error: unknown) => {
    handlePromise = null;
    throw error;
  });
  return handlePromise;
}

// A light client that cannot connect a chain at all. A chain that stops responding halts alone instead.
type FatalCallback = (message: string) => void;
const fatalListeners = new Set<FatalCallback>();
let fatalMessage: string | null = null;

export function onProviderFatal(cb: FatalCallback): () => void {
  fatalListeners.add(cb);
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

// Observed at the store, since the crate reads it for the relay it dials internally. "unavailable" keeps an
// outage apart from cold starts. People is left out, as nothing the page waits on depends on it.
export type SmoldotDbChain = 'relay' | 'hub' | 'bulletin';
export type SmoldotDbOutcome = 'hit' | 'miss' | 'unavailable';
type SmoldotDbListener = (chain: SmoldotDbChain, outcome: SmoldotDbOutcome) => void;
const smoldotDbOutcomes = new Map<SmoldotDbChain, SmoldotDbOutcome>();
const smoldotDbListeners = new Set<SmoldotDbListener>();

function chainRole(genesisHash: string): SmoldotDbChain | null {
  const services = getActiveServicesConfig();
  const key = genesisHash.toLowerCase();
  if (key === services.relay.genesis.toLowerCase()) {
    return 'relay';
  }
  if (key === services.assethub.genesis.toLowerCase()) {
    return 'hub';
  }
  if (key === services.bulletin.genesis.toLowerCase()) {
    return 'bulletin';
  }
  return null;
}

function markSmoldotDb(genesisHash: string, outcome: SmoldotDbOutcome): void {
  const chain = chainRole(genesisHash);
  // First read wins, since only the chain's first add consumes the store.
  if (chain === null || smoldotDbOutcomes.has(chain)) {
    return;
  }
  smoldotDbOutcomes.set(chain, outcome);
  for (const cb of smoldotDbListeners) {
    try {
      cb(chain, outcome);
      // eslint-disable-next-line no-restricted-syntax -- defensive multicast: one buggy subscriber must not block the broadcast to all others.
    } catch {
      /* listener threw, do not let one listener break the broadcast */
    }
  }
}

export function onSmoldotDbOutcome(cb: SmoldotDbListener): void {
  smoldotDbListeners.add(cb);
  for (const [chain, outcome] of smoldotDbOutcomes) {
    try {
      cb(chain, outcome);
      // eslint-disable-next-line no-restricted-syntax -- defensive multicast replay: one buggy late subscriber must not prevent the caller from registering.
    } catch {
      /* listener threw, safe to ignore on replay */
    }
  }
}

export function isChainSupported(genesisHash: string): boolean {
  return getActiveSupportedGenesisHashes().has(genesisHash.toLowerCase());
}

async function resumeFromStore(handle: ChainProviderHandle, key: string): Promise<void> {
  try {
    const warm = await handle.loadDatabase(key);
    reportDbCache(key, warm);
    if (warm) {
      log.debug(`[dot.li provider] resuming ${key} from stored state`);
    }
  } catch (error) {
    // The chain starts from the chain-spec checkpoint, as on a miss, which is slower but correct.
    reportDbCache(key, false);
    log.warn(`[dot.li provider] warm start unavailable for ${key}:`, error);
  }
}

/**
 * Returns `null` for a genesis the active network does not define.
 * smoldot never reconnects underneath its consumers, so a failure or an unrequested stream end halts the chain.
 * Only a failure before connecting raises `onProviderFatal`; an established chain halts alone.
 */
export function createChainProvider(genesisHash: string, hooks?: ChainTransportHooks): JsonRpcProvider | null {
  const key = genesisHash.toLowerCase();
  if (!isChainSupported(key)) {
    log.warn(`[dot.li provider] Unsupported chain: ${genesisHash}`);
    return null;
  }

  return onMessage => {
    const state: {
      connection: Connection | null;
      closed: boolean;
      sync: ChainSyncTap | null;
    } = {
      connection: null,
      closed: false,
      sync: null,
    };
    // A call, so the early guard cannot narrow later reads to `false` while `disconnect` flips it between awaits.
    const isClosed = (): boolean => state.closed;
    const queued: string[] = [];
    const fail = (error: unknown): void => {
      hooks?.onStatus('disconnected');
      hooks?.onHalt(error);
    };
    hooks?.onStatus('connecting');

    void (async () => {
      // The halt runs outside the `try`, so a throwing hook cannot reach the `catch` and halt again.
      let streamEnded = false;
      // A failure before connecting is the light client's, one after it is this chain's.
      let connected = false;
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
        connected = true;
        hooks?.onStatus('connected');
        for (const message of queued) {
          candidate.send(message);
        }
        queued.length = 0;
        // After the flush, so the sync request cannot jump ahead of a caller's.
        const chain = chainKeyForGenesis(key);
        state.sync =
          chain === null
            ? null
            : attachChainSync(
                chain,
                raw => {
                  candidate.send(raw);
                },
                () => handle.lifecycle(key),
              );
        for (;;) {
          const response = await candidate.nextResponse();
          if (response === undefined) {
            streamEnded = true;
            break;
          }
          const parsed = JSON.parse(response) as JsonRpcMessage;
          // polkadot-api would reject a string id it never issued.
          if (state.sync?.intercept(parsed) === true) {
            continue;
          }
          onMessage(parsed);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (connected) {
          log.warn(`[dot.li provider] chain ${key} read failed, halting it: ${reason}`, error);
        } else {
          markFatal(`chain ${key} connection failed: ${reason}`);
        }
        if (!isClosed()) {
          fail(error);
        }
      }
      // Only `disconnect()` ends the stream in order. Otherwise the transport died or overflowed its send budget.
      if (streamEnded && !isClosed()) {
        try {
          fail(new Error(`chain ${key} stopped responding`));
        } catch (error) {
          // Nothing awaits this loop to hear it.
          log.warn(`[dot.li provider] halt listener for chain ${key} threw`, error);
        }
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
        state.sync?.stop();
        state.sync = null;
        state.connection?.close();
        state.connection = null;
      },
    };
  };
}
