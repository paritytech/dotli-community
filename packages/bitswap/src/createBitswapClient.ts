// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fetches blocks with `bitswap_v1_get` over one Bulletin connection, held while a fetch runs and closed after the last.

import { isResponse } from '@polkadot-api/json-rpc-provider';
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { TIMEOUTS } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createPendingReplies,
  createStateMachine,
  fromHex,
  isChainHaltedRpcError,
  listen,
  nest,
  noop,
  setErrorName,
  realTimers,
  serializeError,
  toError,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';

import { BITSWAP_ERRORS, errorCode, withCode } from './errors.js';

const report = createReporter({ flow: 'content' });

/**
 * A Bulletin connection the bitswap client failed to close after its last fetch. Tag `outcome` (`error`) and `reason`
 * (the error name).
 */
const contentBitswapReleaseMetric = defineCount<'error'>('content.bitswap_release');
const bitswapClientTransitionMetric = defineCount<'error'>('bitswap_client.transition');

type Params = {
  /**
   * The Bulletin chain's provider, read at each dial, or null when the caller has no connection for Bulletin. Its
   * connections take the rebuilt chain after a halt and answer the requests the halt cut with the halted marker.
   */
  provider: () => JsonRpcProvider | null;
  /** The clock and timers the budget, the per-call timeout and the retry waits run on. */
  timers?: Timers;
};

export type BitswapClient = ReturnType<typeof createBitswapClient>;

/** The retry state of one fetch, kept across the pool's attempts. */
type FetchAttempts = {
  readonly deadline: number;
  made: number;
  discovery: number;
  transient: number;
};

/** One call of `get`, with the budget it spends on its own and the promise it settles. */
type Caller = {
  deadline: number;
  signal: AbortSignal | undefined;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: unknown) => void;
};

/** The fetch of one CID. Its runner is the caller whose fetch runs, and the others wait behind it. */
type SharedFetch = { kind: 'fetching'; runner: Caller; queued: readonly Caller[] } | { kind: 'ended' };

type Fetching = Extract<SharedFetch, { kind: 'fetching' }>;

/**
 * The connection is held while any fetch runs, retry waits included, and closed after the last. The first request
 * dials, so `undialed` may hold fetches. An ended fetch leaves `fetches`.
 */
type ClientState =
  | { kind: 'undialed'; fetches: ReadonlyMap<string, Fetching> }
  | { kind: 'dialed'; connection: JsonRpcConnection; fetches: ReadonlyMap<string, Fetching> };

type ClientEvent =
  | { kind: 'asked'; cid: string; caller: Caller }
  | { kind: 'callerAborted'; cid: string; caller: Caller }
  | { kind: 'blockFetched'; cid: string; runner: Caller; bytes: Uint8Array }
  | { kind: 'fetchFailed'; cid: string; runner: Caller; error: unknown }
  | { kind: 'fetchEnded' }
  | { kind: 'requested'; id: number; cid: string };

type ClientEffect =
  | { kind: 'resolve'; caller: Caller; bytes: Uint8Array }
  | { kind: 'reject'; caller: Caller; error: unknown }
  | { kind: 'send'; connection: JsonRpcConnection; id: number; cid: string }
  | { kind: 'requestFailed'; id: number; error: Error }
  | { kind: 'disconnect'; connection: JsonRpcConnection };

type ClientMachine = MachineTypes<ClientState, ClientEvent, ClientEffect>;

type SendOnceParams = {
  /** The block to request. */
  cid: string;
  /** How long this one request may wait for a reply. */
  timeoutMs: number;
  /** Stops the wait when it fires. */
  signal: AbortSignal | undefined;
  /** Sends the request through the client's machine, which holds the connection. */
  update: Transition<ClientMachine>['update'];
};

type ClassifyFailureParams = {
  /** The block that failed. */
  cid: string;
  /** What the request threw. */
  error: unknown;
  /** What the fetch saw before it failed. */
  attempts: FetchAttempts;
};

// `bitswap_v1_get` error codes. Anything else, an invalid CID included, is terminal.
const ERROR_FAIL = -32810;
const ERROR_FAIL_RETRY = -32811;
const ERROR_FAIL_BACKOFF = -32812;

/** Creates a client that fetches blocks by CID over the provider's bitswap JSON-RPC, sharing one fetch per CID. */
export function createBitswapClient({ provider, timers = realTimers }: Params) {
  const replies = createPendingReplies<number, Uint8Array>();
  let nextId = 1;
  // Size 1 per name: one attempt at a time within the fetch of a CID.
  const pool = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryIf: error => error instanceof RetryLater,
    retryDelay: (_retry, error) => (error instanceof RetryLater ? error.delayMs : 0),
    timers,
  });

  /** A CID with no fetch gets the caller as its runner, and a CID with one queues the caller behind it. */
  const addCaller: HandlerOf<ClientMachine, 'undialed' | 'dialed', 'asked'> = (
    state,
    { cid, caller },
    { emitState, update },
  ) => {
    const fetch = state.fetches.get(cid);
    if (fetch !== undefined) {
      emitState({
        ...state,
        fetches: new Map(state.fetches).set(cid, { ...fetch, queued: [...fetch.queued, caller] }),
      });
      return;
    }
    emitState({ ...state, fetches: new Map(state.fetches).set(cid, { kind: 'fetching', runner: caller, queued: [] }) });
    startFetch(cid, caller, update);
  };

  const handleFetch = nest<
    ClientMachine,
    'undialed' | 'dialed',
    MachineTypes<SharedFetch, ClientEvent, ClientEffect>,
    'blockFetched' | 'fetchFailed' | 'callerAborted'
  >({
    find(state, event) {
      const fetch = state.fetches.get(event.cid);
      if (fetch === undefined) {
        return null;
      }
      switch (event.kind) {
        // A settle carries the runner it was started for, so one from an earlier runner of the CID finds nothing.
        case 'blockFetched':
        case 'fetchFailed':
          return fetch.runner === event.runner ? fetch : null;
        case 'callerAborted':
          return fetch;
      }
    },
    store(state, { cid }, next) {
      const fetches = new Map(state.fetches);
      switch (next.kind) {
        case 'fetching':
          fetches.set(cid, next);
          break;
        case 'ended':
          fetches.delete(cid);
          break;
      }
      return { ...state, fetches };
    },
    handlers: {
      fetching: {
        blockFetched({ runner, queued }, { bytes }, { emitState, emitSideEffect, update }) {
          emitState({ kind: 'ended' });
          emitSideEffect({ kind: 'resolve', caller: runner, bytes });
          for (const caller of queued) {
            // A copy each, since a caller may transfer its buffer away.
            emitSideEffect({ kind: 'resolve', caller, bytes: bytes.slice() });
          }
          update({ kind: 'fetchEnded' });
        },
        fetchFailed({ runner, queued }, { cid, error }, { emitState, emitSideEffect, update }) {
          const [next, ...rest] = queued;
          if (next === undefined) {
            emitState({ kind: 'ended' });
            update({ kind: 'fetchEnded' });
          } else {
            emitState({ kind: 'fetching', runner: next, queued: rest });
            startFetch(cid, next, update);
          }
          const failure = runner.signal?.aborted === true ? abortError(cid, error) : error;
          emitSideEffect({ kind: 'reject', caller: runner, error: failure });
        },
        // A runner's abort ends its fetch instead, which `fetchFailed` hears.
        callerAborted(state, { cid, caller }, { emitState, emitSideEffect }) {
          if (!state.queued.includes(caller)) {
            return;
          }
          emitState({ ...state, queued: state.queued.filter(queued => queued !== caller) });
          emitSideEffect({ kind: 'reject', caller, error: abortError(cid, caller.signal?.reason) });
        },
      },
      ended: null,
    },
  });

  const client = createStateMachine<ClientMachine>({
    initial: { kind: 'undialed', fetches: new Map() },
    handlers: {
      undialed: {
        asked: addCaller,
        blockFetched: handleFetch,
        fetchFailed: handleFetch,
        callerAborted: handleFetch,
        requested(state, { id, cid }, { emitState, emitSideEffect }) {
          // A request of a fetch that has ended would dial with nothing to close the connection.
          if (!state.fetches.has(cid)) {
            return;
          }
          let connection: JsonRpcConnection;
          // A dial that throws fails this attempt at once, and the next request dials again.
          try {
            const bulletin = provider();
            if (bulletin === null) {
              const error = new Error('Bulletin is not in the supported chain set');
              emitSideEffect({ kind: 'requestFailed', id, error: setErrorName(error, BITSWAP_ERRORS.UNAVAILABLE) });
              return;
            }
            connection = bulletin(hearReply);
          } catch (error) {
            emitSideEffect({ kind: 'requestFailed', id, error: toError(error) });
            return;
          }
          emitState({ kind: 'dialed', connection, fetches: state.fetches });
          emitSideEffect({ kind: 'send', connection, id, cid });
        },
      },
      dialed: {
        asked: addCaller,
        blockFetched: handleFetch,
        fetchFailed: handleFetch,
        callerAborted: handleFetch,
        fetchEnded({ connection, fetches }, _event, { emitState, emitSideEffect }) {
          if (fetches.size > 0) {
            return;
          }
          emitState({ kind: 'undialed', fetches });
          emitSideEffect({ kind: 'disconnect', connection });
        },
        requested({ connection, fetches }, { id, cid }, { emitSideEffect }) {
          if (!fetches.has(cid)) {
            return;
          }
          emitSideEffect({ kind: 'send', connection, id, cid });
        },
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'resolve':
          effect.caller.resolve(effect.bytes);
          return;
        case 'reject':
          effect.caller.reject(effect.error);
          return;
        case 'send':
          try {
            effect.connection.send({ jsonrpc: '2.0', id: effect.id, method: 'bitswap_v1_get', params: [effect.cid] });
          } catch (error) {
            replies.reject(effect.id, toError(error));
          }
          return;
        case 'requestFailed':
          replies.reject(effect.id, effect.error);
          return;
        case 'disconnect':
          try {
            effect.connection.disconnect();
          } catch (error) {
            report.defect(error, {
              step: 'bitswap_release',
              metric: contentBitswapReleaseMetric,
              message: '[dot.li bitswap] closing the Bulletin connection failed:',
            });
          }
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: bitswapClientTransitionMetric,
        message: '[dot.li bitswap] A bitswap client transition threw',
      });
    },
  });

  return {
    /**
     * Fetches one block. Pass `signal` from anything that can be torn down, since a retrying call runs for minutes. A
     * second call for a CID already being fetched waits for that fetch and gets a copy of its bytes. Rejects with an
     * abort error when `signal` fires, and with a coded error when the retries or the total budget run out.
     */
    get(cid: string, signal?: AbortSignal): Promise<Uint8Array> {
      if (signal?.aborted === true) {
        return Promise.reject(abortError(cid, signal.reason));
      }
      // Taken at the call, so a caller queued behind another fetch of the CID spends its own budget while it waits.
      const deadline = timers.now() + TIMEOUTS.BITSWAP_TOTAL_BUDGET;
      let stopListening = noop;
      return new Promise<Uint8Array>((resolve, reject) => {
        const caller: Caller = { deadline, signal, resolve, reject };
        if (signal !== undefined) {
          stopListening = listen({
            target: signal,
            type: 'abort',
            handler: () => {
              client.update({ kind: 'callerAborted', cid, caller });
            },
          });
        }
        client.update({ kind: 'asked', cid, caller });
      }).finally(() => {
        stopListening();
      });
    },
  };

  function hearReply(message: JsonRpcMessage): void {
    if (!isResponse(message) || typeof message.id !== 'number') {
      return;
    }
    if ('error' in message) {
      const error = setErrorName(
        new Error(`bitswap_v1_get failed (code=${String(message.error.code)}): ${message.error.message}`),
        BITSWAP_ERRORS.RPC,
      );
      // A halt is retried on the same connection.
      const halted = isChainHaltedRpcError(message.error);
      replies.reject(message.id, withCode(error, halted ? ERROR_FAIL_RETRY : message.error.code));
      return;
    }
    if (typeof message.result !== 'string') {
      replies.reject(
        message.id,
        setErrorName(
          new Error(`bitswap_v1_get: expected hex string result, got ${typeof message.result}`),
          BITSWAP_ERRORS.RPC,
        ),
      );
      return;
    }
    // Parsed once here, so the sandbox gets a transferred buffer instead of a cloned hex string.
    replies.resolve(message.id, fromHex(message.result));
  }

  function sendOnce({ cid, timeoutMs, signal, update }: SendOnceParams): Promise<Uint8Array> {
    // `addEventListener` never fires on a signal that is already aborted.
    if (signal?.aborted === true) {
      return Promise.reject(abortError(cid));
    }
    const id = nextId++;
    const timer = timers.setTimeout(() => {
      replies.reject(
        id,
        withCode(
          setErrorName(
            new Error(`bitswap_v1_get(${cid}): per-call timed out after ${String(timeoutMs)}ms`),
            BITSWAP_ERRORS.TIMEOUT,
          ),
          ERROR_FAIL_RETRY,
        ),
      );
    }, timeoutMs);
    // smoldot cannot cancel an issued request, so the wait is dropped and its late reply finds no slot.
    const stopListening =
      signal === undefined
        ? noop
        : listen({
            target: signal,
            type: 'abort',
            handler: () => {
              replies.reject(id, abortError(cid));
            },
          });
    const reply = replies.wait(id);
    update({ kind: 'requested', id, cid });
    // Every exit shares one teardown, since the caller's signal outlives the call and would collect listeners.
    return reply.finally(() => {
      timers.clearTimeout(timer);
      stopListening();
    });
  }

  /** What to do after a failed attempt: a `RetryLater` with its wait, or the failure the fetch ends with. */
  function classifyFailure({ cid, error, attempts }: ClassifyFailureParams): Error {
    const code = errorCode(error);
    // Separate counters, so early -32812s cannot pin discovery retries at the backoff cap.
    let backoffAttempt: number;
    if (code === ERROR_FAIL) {
      attempts.discovery += 1;
      // smoldot calls -32810 permanent, but it only means the peers connected at that instant lacked the block,
      // so a retry meets a larger set. Counted in attempts, not time, which slow -32812 runs would drain.
      if (attempts.discovery > 8) {
        return withCode(
          setErrorName(
            new Error(
              `bitswap_v1_get(${cid}): provider discovery exhausted after ${String(attempts.discovery)} failures (${String(attempts.made)} attempts made): ${serializeError(error)}`,
            ),
            BITSWAP_ERRORS.NOT_FOUND,
          ),
          code,
        );
      }
      backoffAttempt = attempts.discovery;
    } else if (code === ERROR_FAIL_RETRY || code === ERROR_FAIL_BACKOFF) {
      attempts.transient += 1;
      backoffAttempt = attempts.transient;
    } else {
      return toError(error);
    }
    // The 1ms floor keeps a nearly spent budget off a zero delay. The deadline check then ends the fetch.
    const delay = Math.min(
      5_000,
      500 * 2 ** Math.min(backoffAttempt - 1, 4),
      Math.max(1, attempts.deadline - timers.now()),
    );
    // Expected while providers are found, so a breadcrumb. The final failure goes back to the caller.
    report.log.event('Bitswap retry', { cid, attempt: attempts.made, code, delay_ms: delay });
    return new RetryLater(delay, error);
  }

  /** Runs the fetch of `cid` for `runner`, one attempt at a time, and sends its outcome to the machine. */
  function startFetch(cid: string, runner: Caller, update: Transition<ClientMachine>['update']): void {
    const { deadline, signal } = runner;
    const attempts: FetchAttempts = { deadline, made: 0, discovery: 0, transient: 0 };
    async function attemptFetch(): Promise<Uint8Array> {
      attempts.made += 1;
      const remaining = attempts.deadline - timers.now();
      if (remaining <= 0) {
        throw setErrorName(
          new Error(
            `bitswap_v1_get(${cid}): timed out after ${String(TIMEOUTS.BITSWAP_TOTAL_BUDGET)}ms (${String(attempts.made - 1)} attempts made)`,
          ),
          BITSWAP_ERRORS.TIMEOUT,
        );
      }
      try {
        return await sendOnce({ cid, timeoutMs: Math.min(60_000, remaining), signal, update });
      } catch (error) {
        throw classifyFailure({ cid, error, attempts });
      }
    }
    update(
      pool.call(attemptFetch, { pool: `fetch:${cid}`, ...(signal !== undefined ? { signal } : {}) }).then(
        bytes => ({ kind: 'blockFetched', cid, runner, bytes }),
        (error: unknown) => ({ kind: 'fetchFailed', cid, runner, error }),
      ),
    );
  }
}

/** A failure worth another attempt once `delayMs` has passed. */
class RetryLater extends Error {
  readonly delayMs: number;

  constructor(delayMs: number, cause: unknown) {
    super('bitswap_v1_get: retrying', { cause });
    this.delayMs = delayMs;
  }
}

function abortError(cid: string, cause?: unknown): Error {
  return setErrorName(
    new Error(`bitswap_v1_get(${cid}): aborted`, cause === undefined ? undefined : { cause }),
    // Marks a local abort by name, since any numeric code outside the JSON-RPC reserved range could be the chain's.
    'AbortError',
  );
}
