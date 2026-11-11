// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One light client per context over truapi-provider's embedded smoldot, shared by the resolver, the broker and every
// product. Each chain comes from its genesis hash through truapi-provider's bundled catalog.

import type { JsonRpcConnection, JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { DEBUG, getChainRoleForGenesis, getActiveSupportedGenesisHashes, type ChainRole } from '@dotli/config/fixed';
import { createReporter, defineCount, m } from '@dotli/metrics';
import { createAsyncTaskPool, createListenerSet, getErrorMessage, log, markHandled } from '@dotli/shared';
import init, { ChainProviderBuilder, setLogLevel, type Connection } from '@parity/truapi-provider';
import wasmUrl from '@parity/truapi-provider/truapi_provider_bg.wasm?url';
import { createSmoldotDb, type SmoldotDb } from './createSmoldotDb.js';
import {
  pageChainSyncReporter,
  type ChainLifecycleWatch,
  type ChainSyncReporter,
  type ChainSyncTap,
  type ParsedRpcMessage,
} from './createChainSyncReporter.js';
import { LIGHT_CLIENT_FOLLOW_LIMIT, type ChainTransport, type ChainTransportHooks } from './transportHooks.js';

const report = createReporter({ flow: 'protocol' });

/**
 * A light-client connection refused at the light client's connection cap, which halts its chain.
 * Tagged `outcome` (error) and `reason` (`cap`).
 */
const smoldotConnectionCapMetric = defineCount<'error'>('smoldot.connection_cap');

/**
 * Liveness heartbeat, the constant `1` once per 60s per light client.
 * Read it with `count_unique(trace)`. Summing counts heartbeats, which scale with the bucket size.
 * A heartbeat because a client dies with its tab or worker and never reports a destroy.
 */
const SMOLDOT_ACTIVE = 'smoldot.active';

// Reached through `loadProvider` too, so a caller that loads the light client lazily keeps sync reporting off its boot path.
export { chainSync } from './createChainSyncReporter.js';

/** What the light client uses of a started truapi-provider. */
export type LightClientEngine = {
  /**
   * Hands the chain its stored database before its first add. Resolves whether there was one, and rejects on a failed
   * read.
   */
  loadDatabase(genesisHash: string): Promise<boolean>;
  /**
   * Adds the chain and opens a JSON-RPC connection to it. Rejects when the chain cannot be added, and with a
   * `LightClientCapError` when the engine already holds as many connections as it allows.
   */
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
  /** Defaults to the page's sync reporter. */
  attachChainSync?: ChainSyncReporter['attachChainSync'];
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
   * Returns the chain's transport, which takes the light client's follow limit, or `null` for a genesis the active
   * network does not define. smoldot never reconnects underneath its consumers, so a failure or an unrequested stream
   * end halts the chain.
   */
  createChainTransport: (genesisHash: string, hooks?: ChainTransportHooks) => ChainTransport | null;
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
// truapi-provider rejects a connect past its connection cap with this text.
const CONNECTION_CAP_TEXT = 'the light client already holds';

// What a chain's sync tap needs of its connection and engine.
type ChainSyncSource = Omit<Parameters<ChainSyncReporter['attachChainSync']>[0], 'chain'>;

type CreateChainSyncTapsParams = {
  attachChainSync: ChainSyncReporter['attachChainSync'];
};

// A chain's connected sources in connect order, and the tap one of them holds.
type ChainSyncEntry = {
  sources: Set<ChainSyncSource>;
  held: { source: ChainSyncSource; tap: ChainSyncTap } | null;
};

type ThrowIfLeftParams = {
  /** The chain whose open waits on the start. */
  key: string;
  /** What the start threw, when it threw. */
  cause?: unknown;
};

// The engine's life. A fatal never clears, so a light client that reached it opens no chain again.
type EngineState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; engine: LightClientEngine; heartbeat: ReturnType<typeof setInterval> | null }
  | { kind: 'fatal'; message: string };

/** A connect the engine refused because it already holds as many connections as it allows. */
export class LightClientCapError extends Error {
  override readonly name = 'LightClientCapError';

  constructor(genesisHash: string, cause: unknown) {
    super(`Light client refused chain ${genesisHash} at its connection cap`, { cause });
  }
}

/**
 * A light client whose engine starts on the first chain it opens. A failed start turns it fatal for good, and a chain
 * opened after a fatal halts without starting the engine.
 *
 * @example
 * const lightClient = createLightClient(createLightClientDeps(null, false)); // no session store, not local
 * const transport = lightClient.createChainTransport(genesisHash); // null for a genesis the network does not define
 */
export function createLightClient({
  db,
  logLevel,
  gauge,
  heartbeatMs = HEARTBEAT_DEFAULT_MS,
  debug = false,
  start = startTruapiProvider,
  attachChainSync = pageChainSyncReporter.attachChainSync,
}: LightClientDeps): LightClient {
  const listeners = createListenerSet<LightClientChange>({
    onListenerError: report.listener('light_client'),
  });
  const dbOutcomes = new Map<SmoldotDbChain, SmoldotDbOutcome>();
  // The read needs no engine, so it overlaps the wasm compile. A blob is megabytes, so an entry lives only until its
  // chain's resume.
  const earlyReads = new Map<string, Promise<string | null>>();
  let engineState: EngineState = { kind: 'idle' };
  // Every chain's first open waits on one start.
  const starts = createAsyncTaskPool({ poolSize: 1 });
  const syncTaps = createChainSyncTaps({ attachChainSync });

  function markFatal(message: string): void {
    if (engineState.kind === 'fatal') {
      return;
    }
    const left = engineState;
    engineState = { kind: 'fatal', message };
    // A dead light client must not be counted as live.
    if (left.kind === 'running' && left.heartbeat !== null) {
      clearInterval(left.heartbeat);
    }
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

  function ensureEngine(key: string): Promise<LightClientEngine> {
    return starts.call(async () => {
      switch (engineState.kind) {
        case 'running':
          return engineState.engine;
        case 'fatal':
          throw new Error(`chain ${key} cannot open: the light client is fatal: ${engineState.message}`);
        case 'idle':
          return startEngine(key);
        case 'starting':
          // The start pool has one slot, so no start is in flight when this runs.
          throw new Error(
            `chain ${key} cannot open: the light client is starting, but its start pool runs one at a time`,
          );
      }
    });
  }

  async function startEngine(key: string): Promise<LightClientEngine> {
    const starting: EngineState = { kind: 'starting' };
    engineState = starting;
    let engine: LightClientEngine;
    try {
      engine = await start({ logLevel, store: observedDb, debug });
    } catch (error) {
      throwIfLeft(starting, { key, cause: error });
      markFatal(`chain ${key} connection failed: ${getErrorMessage(error)}`);
      throw error;
    }
    // The engine has no close, so a start that succeeds after the state moved would leak it. Every other writer of the
    // engine state waits on this start, so that path cannot happen.
    throwIfLeft(starting, { key });
    engineState = {
      kind: 'running',
      engine,
      heartbeat:
        gauge === null
          ? null
          : setInterval(() => {
              gauge(1);
            }, heartbeatMs),
    };
    // At start, so the first bucket counts a client that is already syncing.
    gauge?.(1);
    report.log.event('Light client ready');
    return engine;
  }

  function throwIfLeft(starting: EngineState, { key, cause }: ThrowIfLeftParams): void {
    if (engineState !== starting) {
      throw new Error(`chain ${key} cannot open: the light client left its start`, { cause });
    }
  }

  function readEarly(genesisHash: string): void {
    // Once the engine is up there is nothing to overlap, a chain it already added reads nothing, and a fatal light
    // client opens no chain.
    if (db === null || !isEngineComing(engineState) || earlyReads.has(genesisHash)) {
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
      const live = await ensureEngine(key);
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

  function createChainTransport(genesisHash: string, hooks?: ChainTransportHooks): ChainTransport | null {
    const key = genesisHash.toLowerCase();
    if (!isChainSupported(key)) {
      log.warn(`[dot.li provider] Unsupported chain: ${genesisHash}`);
      return null;
    }

    function provider(onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
      const state: {
        connection: LightClientConnection | null;
        closed: boolean;
        sync: ChainSyncSource | null;
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
      function halt(error: unknown): void {
        try {
          fail(error);
        } catch (thrown) {
          // Nothing awaits the read loop to hear it.
          report.listener('light_client.halt')(thrown);
        }
      }
      function releaseSync(): void {
        if (state.sync === null) {
          return;
        }
        syncTaps.leave(key, state.sync);
        state.sync = null;
      }
      function reportFailure(error: unknown, connected: boolean): void {
        const reason = getErrorMessage(error);
        if (connected) {
          log.warn(`[dot.li provider] chain ${key} read failed, halting it: ${reason}`, error);
          return;
        }
        if (error instanceof LightClientCapError) {
          report.expected(error, {
            step: 'light_client_connect',
            metric: smoldotConnectionCapMetric,
            reason: 'cap',
            message: `[dot.li provider] chain ${key} is past the light client's connection cap, halting it: ${reason}`,
          });
          return;
        }
        markFatal(`chain ${key} connection failed: ${reason}`);
      }
      hooks?.onStatus('connecting');
      void readResponses();

      async function readResponses(): Promise<void> {
        // The halt runs outside the `try`, so a throwing hook cannot reach the `catch` and halt again.
        let streamEnded = false;
        // A failure before connecting is the light client's, one after it is this chain's. A cap rejection before
        // connecting is the chain's failure too.
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
          const source: ChainSyncSource = {
            send: raw => {
              candidate.send(raw);
            },
            watchLifecycle: () => live.lifecycle(key),
          };
          state.sync = source;
          syncTaps.join(key, source);
          for (;;) {
            const response = await candidate.nextResponse();
            // A response read before `disconnect()` must not reach a listener that already left.
            if (isClosed()) {
              break;
            }
            if (response === undefined) {
              streamEnded = true;
              break;
            }
            // The light client answers only JSON-RPC, which goes on unchecked as the held provider wire.
            const parsed = JSON.parse(response) as JsonRpcMessage;
            // polkadot-api would reject a string id it never issued.
            if (syncTaps.intercept(key, source, parsed)) {
              continue;
            }
            onMessage(parsed);
          }
        } catch (error) {
          reportFailure(error, connected);
          if (!isClosed()) {
            halt(error);
          }
        } finally {
          // A stream that ended or broke hands the chain's tap to another of its connections.
          releaseSync();
        }
        // Only `disconnect()` ends the stream in order. Otherwise the transport died or overflowed its send budget.
        if (streamEnded && !isClosed()) {
          halt(new Error(`chain ${key} stopped responding`));
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
          releaseSync();
          state.connection?.close();
          state.connection = null;
        },
      };
    }
    return { provider, followLimit: LIGHT_CLIENT_FOLLOW_LIMIT };
  }

  return {
    createChainTransport,
    isChainSupported,
    status: () => ({ fatal: engineState.kind === 'fatal' ? engineState.message : null, db: new Map(dbOutcomes) }),
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
          m.gauge(SMOLDOT_ACTIVE, value);
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
  return withConnectionCapError(builder.build());
}

/**
 * Wraps `engine` so that a `connect` rejection that states the wasm's connection cap rejects with `LightClientCapError`.
 * Never throws. Any other rejection passes through unchanged. The wasm states its cap only in a rejection's text, so the
 * mapping happens where the failure leaves the wasm.
 */
export function withConnectionCapError(engine: LightClientEngine): LightClientEngine {
  return {
    loadDatabase: genesisHash => engine.loadDatabase(genesisHash),
    lifecycle: genesisHash => engine.lifecycle(genesisHash),
    async connect(genesisHash) {
      try {
        return await engine.connect(genesisHash);
      } catch (error) {
        if (getErrorMessage(error).includes(CONNECTION_CAP_TEXT)) {
          throw new LightClientCapError(genesisHash, error);
        }
        throw error;
      }
    },
  };
}

/**
 * One sync tap per chain, held by one of its connected sources, since every connection of a chain would report the same
 * sync. When the holder leaves, a source still connected takes the tap, so a chain reports its sync while any connection
 * of it is open. Never throws on its own, since `attachChainSync` never throws. A call throws only what the held tap's
 * `stop` or `intercept` throws.
 */
function createChainSyncTaps({ attachChainSync }: CreateChainSyncTapsParams) {
  const entries = new Map<string, ChainSyncEntry>();

  function attach(key: string, entry: ChainSyncEntry, source: ChainSyncSource): void {
    const chain = getChainRoleForGenesis(key);
    if (chain === null) {
      return;
    }
    const tap = attachChainSync({ chain, ...source });
    if (tap !== null) {
      entry.held = { source, tap };
    }
  }

  return {
    /** Adds `source` as connected to the chain, which takes the tap when no source holds it. Never throws. */
    join(key: string, source: ChainSyncSource): void {
      const entry = entries.get(key) ?? { sources: new Set(), held: null };
      entries.set(key, entry);
      entry.sources.add(source);
      if (entry.held === null) {
        attach(key, entry, source);
      }
    },
    /**
     * Removes `source`, and when it held the tap, stops it and attaches one to the next source. A repeat does nothing.
     * Throws only what the stopped tap's `stop` throws, and never from the attach.
     */
    leave(key: string, source: ChainSyncSource): void {
      const entry = entries.get(key);
      if (entry?.sources.delete(source) !== true) {
        return;
      }
      if (entry.sources.size === 0) {
        entries.delete(key);
      }
      if (entry.held?.source !== source) {
        return;
      }
      entry.held.tap.stop();
      entry.held = null;
      const [next] = entry.sources;
      if (next !== undefined) {
        attach(key, entry, next);
      }
    },
    /** Whether `parsed` was the tap's own reply, true only on the source that holds the tap. Throws what the tap throws. */
    intercept(key: string, source: ChainSyncSource, parsed: ParsedRpcMessage): boolean {
      const held = entries.get(key)?.held;
      return held?.source === source && held.tap.intercept(parsed);
    },
  };
}

// Whether the engine may still come up.
function isEngineComing(state: EngineState): boolean {
  switch (state.kind) {
    case 'idle':
    case 'starting':
      return true;
    case 'running':
    case 'fatal':
      return false;
  }
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
