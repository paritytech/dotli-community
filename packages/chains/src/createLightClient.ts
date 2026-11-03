// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One light client per context over truapi-provider's embedded smoldot, shared by the resolver, the broker and every
// product. Each chain comes from its genesis hash through truapi-provider's bundled catalog.

import type { JsonRpcConnection, JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import type { JsonRpcProvider } from 'polkadot-api';
import { DEBUG, getChainRoleForGenesis, getActiveSupportedGenesisHashes, type ChainRole } from '@dotli/config/fixed';
import { m, reportListener, spans } from '@dotli/metrics';
import { createAsyncTaskPool, createListenerSet, getErrorMessage, log, markHandled } from '@dotli/shared';
import init, { ChainProviderBuilder, setLogLevel, type Connection } from '@parity/truapi-provider';
import wasmUrl from '@parity/truapi-provider/truapi_provider_bg.wasm?url';
import { createSmoldotDb, type SmoldotDb } from './createSmoldotDb.js';
import { pageChainSyncReporter, type ChainLifecycleWatch, type ChainSyncTap } from './createChainSyncReporter.js';
import type { ChainTransportHooks } from './transportHooks.js';

// Reached through `loadProvider` too, so a caller that loads the light client lazily keeps sync reporting off its boot path.
export { chainSync } from './createChainSyncReporter.js';

/** What the light client uses of a started truapi-provider. */
export type LightClientEngine = {
  /**
   * Hands the chain its stored database before its first add. Resolves whether there was one, and rejects on a failed
   * read.
   */
  loadDatabase(genesisHash: string): Promise<boolean>;
  /** Adds the chain and opens a JSON-RPC connection to it. Rejects when the chain cannot be added. */
  connect(genesisHash: string): Promise<LightClientConnection>;
  /** Watches the chain's lifecycle snapshots. May throw when the engine offers no watch. */
  lifecycle(genesisHash: string): ChainLifecycleWatch;
};

export type LightClientConnection = Pick<Connection, 'send' | 'close' | 'nextResponse'>;

export type StartEngineParams = {
  /** truapi-provider's log level, `off` for none. */
  logLevel: string;
  /** Read for each chain's first add, and written as it finalizes. */
  store: SmoldotDb | null;
  /** Lets the debug console change the log level. */
  debug: boolean;
};

export type StartEngine = (params: StartEngineParams) => Promise<LightClientEngine>;

export type LightClientDeps = {
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
};

// Observed at the store, since the crate reads it for the relay it dials internally. "unavailable" keeps an
// outage apart from cold starts.
export type SmoldotDbChain = Exclude<ChainRole, 'people'>;
export type SmoldotDbOutcome = 'hit' | 'miss' | 'unavailable';

export type LightClientStatus = {
  /** Why no chain can be opened, once one could not. It never clears. */
  readonly fatal: string | null;
  /** Each chain's first read of its stored database. */
  readonly db: ReadonlyMap<SmoldotDbChain, SmoldotDbOutcome>;
};

export type LightClientChange =
  { kind: 'fatal'; message: string } | { kind: 'db'; chain: SmoldotDbChain; outcome: SmoldotDbOutcome };

export type LightClient = {
  /**
   * Returns `null` for a genesis the active network does not define. smoldot never reconnects underneath its
   * consumers, so a failure or an unrequested stream end halts the chain.
   */
  createChainProvider: (genesisHash: string, hooks?: ChainTransportHooks) => JsonRpcProvider | null;
  /** Whether the active network defines the genesis. */
  isChainSupported: (genesisHash: string) => boolean;
  /** The light client's state now, as a copy. */
  status: () => LightClientStatus;
  /** Hears each change after the call, so a reader that joins late starts from `status()`. */
  subscribe: (listener: (change: LightClientChange) => void) => () => void;
};

const HEARTBEAT_DEFAULT_MS = 60_000;
const LOG_LEVEL_KEY = 'dotli:truapi-provider-log';
const HEARTBEAT_KEY = 'dotli:smoldot-heartbeat-ms';

/**
 * A light client whose engine starts on the first chain it opens, with a failed start retried by the next open.
 *
 * @example
 * const lightClient = createLightClient(createLightClientDeps(null, false)); // no session store, not local
 * const provider = lightClient.createChainProvider(genesisHash); // null for a genesis the network does not define
 */
export function createLightClient({
  db,
  logLevel,
  gauge,
  heartbeatMs = HEARTBEAT_DEFAULT_MS,
  debug = false,
  start = startTruapiProvider,
}: LightClientDeps): LightClient {
  const listeners = createListenerSet<LightClientChange>({
    onListenerError: reportListener('protocol', 'light_client'),
  });
  const dbOutcomes = new Map<SmoldotDbChain, SmoldotDbOutcome>();
  // The read needs no engine, so it overlaps the wasm compile. A blob is megabytes, so an entry lives only until its
  // chain's resume.
  const earlyReads = new Map<string, Promise<string | null>>();
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
    const chain = getChainRoleForGenesis(genesisHash);
    // First read wins, since only the chain's first add consumes the store. People is left out, as nothing the page
    // waits on depends on it.
    if (chain === null || chain === 'people' || dbOutcomes.has(chain)) {
      return;
    }
    dbOutcomes.set(chain, outcome);
    listeners.emit({ kind: 'db', chain, outcome });
  }

  // The relay's blob is only read here, never through `loadDatabase`. A failure must reject, not read as empty.
  const observedDb: SmoldotDb | null =
    db === null
      ? null
      : {
          async load(genesisHash: string) {
            try {
              const blob = await readStored(db, genesisHash);
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
    // A start retried after a fatal is still not counted, as the fatal never clears.
    if (gauge === null || fatal !== null) {
      return;
    }
    // At start, so the first bucket counts a client that is already syncing.
    gauge(1);
    heartbeat = setInterval(() => {
      gauge(1);
    }, heartbeatMs);
  }

  function ensureEngine(): Promise<LightClientEngine> {
    return starts.call(async () => {
      if (engine !== null) {
        return engine;
      }
      const next = await start({ logLevel, store: observedDb, debug });
      engine = next;
      startHeartbeat();
      log.event('Light client ready', { flow: 'protocol' });
      return next;
    });
  }

  function readEarly(genesisHash: string): void {
    if (db === null) {
      return;
    }
    // Once the engine is up there is nothing to overlap, and a chain it already added reads nothing.
    if (engine !== null) {
      return;
    }
    if (earlyReads.has(genesisHash)) {
      return;
    }
    earlyReads.set(genesisHash, markHandled(db.load(genesisHash)));
  }

  function readStored(store: SmoldotDb, genesisHash: string): Promise<string | null> {
    const early = earlyReads.get(genesisHash);
    if (early === undefined) {
      return store.load(genesisHash);
    }
    earlyReads.delete(genesisHash);
    return early;
  }

  async function prepareChain(key: string): Promise<LightClientEngine> {
    readEarly(key);
    try {
      const live = await ensureEngine();
      // Must run before the chain is added: only a chain's first add consumes a blob.
      await resumeFromStore(live, key);
      return live;
    } finally {
      earlyReads.delete(key);
    }
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

    function provider(onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
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
      function isClosed(): boolean {
        return state.closed;
      }
      const queued: string[] = [];
      function fail(error: unknown): void {
        hooks?.onStatus('disconnected');
        hooks?.onHalt(error);
      }
      hooks?.onStatus('connecting');
      void readResponses();

      async function readResponses(): Promise<void> {
        // The halt runs outside the `try`, so a throwing hook cannot reach the `catch` and halt again.
        let streamEnded = false;
        // A failure before connecting is the light client's, one after it is this chain's.
        let connected = false;
        try {
          const live = await prepareChain(key);
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
          const chain = getChainRoleForGenesis(key);
          state.sync =
            chain === null
              ? null
              : pageChainSyncReporter.attachChainSync({
                  chain,
                  send: raw => {
                    candidate.send(raw);
                  },
                  watchLifecycle: () => live.lifecycle(key),
                });
          for (;;) {
            const response = await candidate.nextResponse();
            if (response === undefined) {
              streamEnded = true;
              break;
            }
            // The light client answers only JSON-RPC, which goes on unchecked as the held provider wire.
            const parsed = JSON.parse(response) as JsonRpcMessage;
            // polkadot-api would reject a string id it never issued.
            if (state.sync?.intercept(parsed) === true) {
              continue;
            }
            onMessage(parsed);
          }
        } catch (error) {
          const reason = getErrorMessage(error);
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
      }

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
    }
    return provider;
  }

  return {
    createChainProvider,
    isChainSupported,
    status: () => ({ fatal, db: new Map(dbOutcomes) }),
    subscribe: listeners.subscribe,
  };
}

/**
 * The light client a context starts, tuned by its session where it has one (`null` in the SharedWorker). A test raises
 * the log level, or slows the heartbeat so only the startup report lands and the count does not follow wall-clock.
 * `local` on a localhost page, where the light client logs at info.
 */
export function createLightClientDeps(session: Pick<Storage, 'getItem'> | null, local: boolean): LightClientDeps {
  const level = session?.getItem(LOG_LEVEL_KEY) ?? '';
  const heartbeatMs = Number(session?.getItem(HEARTBEAT_KEY) ?? '');
  return {
    db: createSmoldotDb(),
    logLevel: level !== '' ? level : local ? 'info' : 'off',
    gauge: m.enabled
      ? value => {
          m.gauge(spans.SMOLDOT_ACTIVE, value);
        }
      : null,
    ...(Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? { heartbeatMs } : {}),
    debug: DEBUG,
  };
}

/** truapi-provider's wasm, loaded and built once per light client. */
export async function startTruapiProvider({ logLevel, store, debug }: StartEngineParams): Promise<LightClientEngine> {
  await init({ module_or_path: wasmUrl });
  setLogLevel(logLevel);
  if (debug) {
    Reflect.set(globalThis, '__truapiProvider', { setLogLevel });
  }
  const builder = new ChainProviderBuilder();
  // Over https the browser blocks `ws://` to non-localhost peers as mixed content.
  builder.setConnectionTypes({ unsecure: false });
  if (store !== null) {
    builder.setStorage(store);
  }
  return builder.build();
}

async function resumeFromStore(engine: LightClientEngine, key: string): Promise<void> {
  try {
    const warm = await engine.loadDatabase(key);
    pageChainSyncReporter.reportDbCache(key, warm);
    if (warm) {
      log.debug(`[dot.li provider] resuming ${key} from stored state`);
    }
  } catch (error) {
    // The chain starts from the chain-spec checkpoint, as on a miss, which is slower but correct.
    pageChainSyncReporter.reportDbCache(key, false);
    log.warn(`[dot.li provider] warm start unavailable for ${key}:`, error);
  }
}
