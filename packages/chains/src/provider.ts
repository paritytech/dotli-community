// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One light client per context over truapi-provider's embedded smoldot, shared by the resolver, the broker and every
// product. Each chain comes from its genesis hash through truapi-provider's bundled catalog.

import type { JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import type { JsonRpcProvider } from 'polkadot-api';
import { DEBUG, chainRoleForGenesis, getActiveSupportedGenesisHashes, type ChainRole } from '@dotli/config/fixed';
import { m, reportListener, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, createListenerSet, errorMessage, log } from '@dotli/shared';
import init, { ChainProviderBuilder, setLogLevel, type Connection } from '@parity/truapi-provider';
import wasmUrl from '@parity/truapi-provider/truapi_provider_bg.wasm?url';
import { createSmoldotDb, type SmoldotDb } from './smoldot-db.js';
import { attachChainSync, reportDbCache, type ChainLifecycleWatch, type ChainSyncTap } from './chain-sync.js';
import type { ChainTransportHooks } from './transport-hooks.js';

// Reached through `loadProvider` too, so a caller that loads the light client lazily keeps sync reporting off its boot path.
export { enableSyncReporting, onChainDetail, onChainSync } from './chain-sync.js';

/** What the light client uses of a started truapi-provider. */
export interface LightClientEngine {
  loadDatabase(genesisHash: string): Promise<boolean>;
  connect(genesisHash: string): Promise<LightClientConnection>;
  lifecycle(genesisHash: string): ChainLifecycleWatch;
}

export type LightClientConnection = Pick<Connection, 'send' | 'close' | 'nextResponse'>;

export interface StartEngineOptions {
  logLevel: string;
  /** Read for each chain's first add, and written as it finalizes. */
  store: SmoldotDb | null;
  /** Lets the debug console change the log level. */
  debug: boolean;
}

export type StartEngine = (options: StartEngineOptions) => Promise<LightClientEngine>;

export interface LightClientDeps {
  /** Each chain's stored database, or `null` where IndexedDB is missing and every chain starts cold. */
  db: SmoldotDb | null;
  /** truapi-provider's log level, `off` for none. */
  logLevel: string;
  /** Counts this light client as live. `null` where metrics go nowhere, so no timer keeps an idle SharedWorker up. */
  gauge: ((value: number) => void) | null;
  /** The gauge reports at start and then on this interval. */
  heartbeatMs?: number;
  /** Puts the log level on `globalThis.__truapiProvider` for the debug console. */
  debug?: boolean;
  /** Defaults to truapi-provider's wasm. */
  start?: StartEngine;
}

// Observed at the store, since the crate reads it for the relay it dials internally. "unavailable" keeps an
// outage apart from cold starts.
export type SmoldotDbChain = Exclude<ChainRole, 'people'>;
export type SmoldotDbOutcome = 'hit' | 'miss' | 'unavailable';

export interface LightClientStatus {
  /** Why no chain can be opened, once one could not. It never clears. */
  readonly fatal: string | null;
  /** Each chain's first read of its stored database. */
  readonly db: ReadonlyMap<SmoldotDbChain, SmoldotDbOutcome>;
}

export type LightClientChange =
  { kind: 'fatal'; message: string } | { kind: 'db'; chain: SmoldotDbChain; outcome: SmoldotDbOutcome };

export interface LightClient {
  /**
   * Resolves `null` for a genesis the active network does not define. smoldot never reconnects underneath its
   * consumers, so a failure or an unrequested stream end halts the chain.
   */
  createChainProvider: (genesisHash: string, hooks?: ChainTransportHooks) => JsonRpcProvider | null;
  isChainSupported: (genesisHash: string) => boolean;
  status: () => LightClientStatus;
  /** Hears each change after the call, so a reader that joins late starts from `status()`. */
  subscribe: (listener: (change: LightClientChange) => void) => () => void;
}

const HEARTBEAT_DEFAULT_MS = 60_000;
const LOG_LEVEL_KEY = 'dotli:truapi-provider-log';
const HEARTBEAT_KEY = 'dotli:smoldot-heartbeat-ms';

/**
 * The light client a context starts, tuned by its session where it has one (`null` in the SharedWorker). A test raises
 * the log level, or slows the heartbeat so only the startup report lands and the count does not follow wall-clock.
 * `local` on a localhost page, where the light client logs at info.
 */
export function lightClientDeps(session: Pick<Storage, 'getItem'> | null, local: boolean): LightClientDeps {
  const level = session?.getItem(LOG_LEVEL_KEY) ?? '';
  const heartbeatMs = Number(session?.getItem(HEARTBEAT_KEY) ?? '');
  return {
    db: createSmoldotDb(),
    logLevel: level !== '' ? level : local ? 'info' : 'off',
    gauge: m.enabled
      ? value => {
          m.gauge(S.SMOLDOT_ACTIVE, value);
        }
      : null,
    ...(Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? { heartbeatMs } : {}),
    debug: DEBUG,
  };
}

/** truapi-provider's wasm, loaded and built once per light client. */
export const startTruapiProvider: StartEngine = async ({ logLevel, store, debug }) => {
  await init({ module_or_path: wasmUrl });
  setLogLevel(logLevel);
  if (debug) {
    (globalThis as unknown as { __truapiProvider?: { setLogLevel: (level: string) => void } }).__truapiProvider = {
      setLogLevel,
    };
  }
  const builder = new ChainProviderBuilder();
  // Over https the browser blocks `ws://` to non-localhost peers as mixed content.
  builder.setConnectionTypes({ unsecure: false });
  if (store !== null) {
    builder.setStorage(store);
  }
  return builder.build();
};

async function resumeFromStore(engine: LightClientEngine, key: string): Promise<void> {
  try {
    const warm = await engine.loadDatabase(key);
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

export function createLightClient(deps: LightClientDeps): LightClient {
  const start = deps.start ?? startTruapiProvider;
  const listeners = createListenerSet<LightClientChange>({
    onListenerError: reportListener('protocol', 'light_client'),
  });
  const dbOutcomes = new Map<SmoldotDbChain, SmoldotDbOutcome>();
  let fatal: string | null = null;
  let engine: LightClientEngine | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // Every chain's first open waits on one start. A failed start is tried again by the next open.
  const starts = createAsyncTaskPool({ poolSize: 1 });

  function markFatal(message: string): void {
    if (fatal !== null) {
      return;
    }
    fatal = message;
    // A dead light client must not be counted as live.
    clearInterval(heartbeat);
    log.error(`[dot.li provider] ${message}`);
    listeners.emit({ kind: 'fatal', message });
  }

  function markDb(genesisHash: string, outcome: SmoldotDbOutcome): void {
    const chain = chainRoleForGenesis(genesisHash);
    // First read wins, since only the chain's first add consumes the store. People is left out, as nothing the page
    // waits on depends on it.
    if (chain === null || chain === 'people' || dbOutcomes.has(chain)) {
      return;
    }
    dbOutcomes.set(chain, outcome);
    listeners.emit({ kind: 'db', chain, outcome });
  }

  // The relay's blob is only read here, never through `loadDatabase`. A failure must reject, not read as empty.
  const { db } = deps;
  const observedDb: SmoldotDb | null =
    db === null
      ? null
      : {
          load: async genesisHash => {
            try {
              const blob = await db.load(genesisHash);
              markDb(genesisHash, blob !== null ? 'hit' : 'miss');
              return blob;
            } catch (error) {
              markDb(genesisHash, 'unavailable');
              throw error;
            }
          },
          save: (genesisHash, blob) => db.save(genesisHash, blob),
        };

  function startHeartbeat(): void {
    const { gauge } = deps;
    // A start retried after a fatal is still not counted, as the fatal never clears.
    if (gauge === null || fatal !== null) {
      return;
    }
    // At start, so the first bucket counts a client that is already syncing.
    gauge(1);
    heartbeat = setInterval(() => {
      gauge(1);
    }, deps.heartbeatMs ?? HEARTBEAT_DEFAULT_MS);
  }

  function ensureEngine(): Promise<LightClientEngine> {
    return starts.call(async () => {
      if (engine !== null) {
        return engine;
      }
      const next = await start({ logLevel: deps.logLevel, store: observedDb, debug: deps.debug ?? false });
      engine = next;
      startHeartbeat();
      log.event('Light client ready', { flow: 'protocol' });
      return next;
    });
  }

  function isChainSupported(genesisHash: string): boolean {
    return getActiveSupportedGenesisHashes().has(genesisHash.toLowerCase());
  }

  function createChainProvider(genesisHash: string, hooks?: ChainTransportHooks): JsonRpcProvider | null {
    const key = genesisHash.toLowerCase();
    if (!isChainSupported(key)) {
      log.warn(`[dot.li provider] Unsupported chain: ${genesisHash}`);
      return null;
    }

    return onMessage => {
      const state: {
        connection: LightClientConnection | null;
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
          const live = await ensureEngine();
          // Must precede `connect`: only a chain's first add consumes a blob.
          await resumeFromStore(live, key);
          const candidate = await live.connect(key);
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
          const chain = chainRoleForGenesis(key);
          state.sync =
            chain === null
              ? null
              : attachChainSync(
                  chain,
                  raw => {
                    candidate.send(raw);
                  },
                  () => live.lifecycle(key),
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
          const reason = errorMessage(error);
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
            reportListener('protocol', 'light_client.halt')(error);
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

  return {
    createChainProvider,
    isChainSupported,
    status: () => ({ fatal, db: new Map(dbOutcomes) }),
    subscribe: listeners.subscribe,
  };
}
