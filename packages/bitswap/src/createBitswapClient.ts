// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fetches blocks with `bitswap_v1_get` over one Bulletin connection, held while a fetch runs and closed after the last.

import { isResponse } from '@polkadot-api/json-rpc-provider';
import type { JsonRpcConnection, JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { TIMEOUTS } from '@dotli/config';
import { reportDefect, spans as S } from '@dotli/metrics';
import type { RemoteChainProvider } from '@dotli/protocol';
import {
  CHAIN_HALTED_ERROR_DATA,
  createAsyncTaskPool,
  createPendingReplies,
  createSharedRun,
  fromHex,
  log,
  setErrorName,
  realTimers,
  serializeError,
  type Timers,
  toError,
} from '@dotli/shared';

import { BITSWAP_ERRORS, errorCode, withCode } from './errors.js';

type Params = {
  /** The Bulletin chain's provider, read at each dial, or null when the caller has no connection for Bulletin. */
  provider: () => RemoteChainProvider | null;
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

/** Callers of one CID and the bytes its fetch left for those still waiting. */
type SharedFetch = {
  holders: number;
  bytes: Uint8Array | null;
};

type SendOnceParams = {
  /** The block to request. */
  cid: string;
  /** How long this one request may wait for a reply. */
  timeoutMs: number;
  /** Stops the wait when it fires. */
  signal: AbortSignal | undefined;
};

type ClassifyFailureParams = {
  /** The block that failed. */
  cid: string;
  /** What the request threw. */
  error: unknown;
  /** What the fetch saw before it failed. */
  attempts: FetchAttempts;
};

type FetchBlockParams = {
  /** The block to fetch. */
  cid: string;
  /** The time the whole fetch must end by, on the client's clock. */
  deadline: number;
  /** Stops the fetch when it fires. */
  signal: AbortSignal | undefined;
};

// `bitswap_v1_get` error codes. Anything else, an invalid CID included, is terminal.
const ERROR_FAIL = -32810;
const ERROR_FAIL_RETRY = -32811;
const ERROR_FAIL_BACKOFF = -32812;

/** Marks a local abort by name, since any numeric code outside the JSON-RPC reserved range could be the chain's. */
const ABORT_ERROR_NAME = 'AbortError';

const PER_CALL_TIMEOUT_MS = 60_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5_000;

// smoldot calls -32810 permanent, but it only means the peers connected at that instant lacked the block,
// so a retry meets a larger set. Counted in attempts, not time, which slow -32812 runs would drain.
const DISCOVERY_RETRIES = 8;

/** Creates a client that fetches blocks by CID over the provider's bitswap JSON-RPC, sharing one fetch per CID. */
export function createBitswapClient({ provider, timers = realTimers }: Params) {
  const replies = createPendingReplies<number, Uint8Array>();
  const shared = new Map<string, SharedFetch>();
  let nextId = 1;
  let connection: JsonRpcConnection | null = null;
  // Size 1 per name: one fetch per CID at a time, and one attempt at a time within it.
  const pool = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryIf: error => error instanceof RetryLater,
    retryDelay: (_retry, error) => (error instanceof RetryLater ? error.delayMs : 0),
    timers,
  });
  // Every fetch holds the connection from its call until it settles, retry waits included.
  const holding = createSharedRun({ begin: () => release });

  function dial(): JsonRpcConnection {
    if (connection !== null) {
      return connection;
    }
    const bulletin = provider();
    if (bulletin === null) {
      throw setErrorName(new Error('Bulletin is not in the supported chain set'), BITSWAP_ERRORS.UNAVAILABLE);
    }
    const opened = bulletin(
      (message: JsonRpcMessage) => {
        if (!isResponse(message) || typeof message.id !== 'number') {
          return;
        }
        if ('error' in message) {
          const error = setErrorName(
            new Error(`bitswap_v1_get failed (code=${String(message.error.code)}): ${message.error.message}`),
            BITSWAP_ERRORS.RPC,
          );
          // A halt answer arrives before `onHalt` drops the connection, so the retry redials a rebuilt chain.
          const halted = message.error.data === CHAIN_HALTED_ERROR_DATA;
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
      },
      reason => {
        // The next attempt redials. Requests the halt never answered are rejected here, and a halt from a replaced
        // connection must not touch its successor.
        if (connection !== opened) {
          return;
        }
        connection = null;
        replies.rejectAll(() => {
          const error = setErrorName(new Error('Bulletin connection halted'), BITSWAP_ERRORS.CONNECTION);
          // A halted chain is rebuilt on reconnect, so it is retried. A dead frame is fatal.
          return reason === 'chain' ? withCode(error, ERROR_FAIL_RETRY) : error;
        });
      },
    );
    connection = opened;
    return opened;
  }

  function release(): void {
    const held = connection;
    if (held === null) {
      return;
    }
    // Cleared first, so the closed connection's halt finds itself replaced.
    connection = null;
    try {
      held.disconnect();
    } catch (error) {
      reportDefect(error, {
        flow: 'content',
        step: 'bitswap_release',
        metric: S.CONTENT_BITSWAP_RELEASE,
        message: '[dot.li bitswap] closing the Bulletin connection failed:',
      });
    }
  }

  function sendOnce({ cid, timeoutMs, signal }: SendOnceParams): Promise<Uint8Array> {
    const id = nextId++;
    const active = dial();
    // `addEventListener` never fires on a signal that is already aborted.
    if (signal?.aborted === true) {
      return Promise.reject(abortError(cid));
    }
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
    function rejectOnAbort(): void {
      replies.reject(id, abortError(cid));
    }
    signal?.addEventListener('abort', rejectOnAbort, { once: true });
    const reply = replies.wait(id);
    try {
      active.send({ jsonrpc: '2.0', id, method: 'bitswap_v1_get', params: [cid] });
    } catch (error) {
      replies.reject(id, toError(error));
    }
    // Every exit shares one teardown, since the caller's signal outlives the call and would collect listeners.
    return reply.finally(() => {
      timers.clearTimeout(timer);
      signal?.removeEventListener('abort', rejectOnAbort);
    });
  }

  /** What to do after a failed attempt: a `RetryLater` with its wait, or the failure the fetch ends with. */
  function classifyFailure({ cid, error, attempts }: ClassifyFailureParams): Error {
    const code = errorCode(error);
    // Separate counters, so early -32812s cannot pin discovery retries at the backoff cap.
    let backoffAttempt: number;
    if (code === ERROR_FAIL) {
      attempts.discovery += 1;
      if (attempts.discovery > DISCOVERY_RETRIES) {
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
      BACKOFF_CAP_MS,
      BACKOFF_BASE_MS * 2 ** Math.min(backoffAttempt - 1, 4),
      Math.max(1, attempts.deadline - timers.now()),
    );
    // Expected while providers are found, so a breadcrumb. The final failure goes back to the caller.
    log.event('Bitswap retry', { flow: 'content', cid, attempt: attempts.made, code, delay_ms: delay });
    return new RetryLater(delay, error);
  }

  function fetchBlock({ cid, deadline, signal }: FetchBlockParams): Promise<Uint8Array> {
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
        return await sendOnce({ cid, timeoutMs: Math.min(PER_CALL_TIMEOUT_MS, remaining), signal });
      } catch (error) {
        throw classifyFailure({ cid, error, attempts });
      }
    }
    return pool.call(attemptFetch, { pool: `fetch:${cid}`, ...(signal !== undefined ? { signal } : {}) });
  }

  return {
    /**
     * Fetches one block. Pass `signal` from anything that can be torn down, since a retrying call runs for minutes. A
     * second call for a CID already being fetched waits for that fetch and gets a copy of its bytes. Rejects with an
     * abort error when `signal` fires, and with a coded error when the retries or the total budget run out.
     */
    get(cid: string, signal?: AbortSignal): Promise<Uint8Array> {
      // Taken at the call, so a caller queued behind another fetch of the CID spends its own budget while it waits.
      const deadline = timers.now() + TIMEOUTS.BITSWAP_TOTAL_BUDGET;
      const stop = holding.join();
      const entry = shared.get(cid) ?? { holders: 0, bytes: null };
      shared.set(cid, entry);
      entry.holders += 1;
      // Idempotent: a call queued behind a fetch of the same CID finds its bytes and returns them.
      async function fetchOnce(): Promise<Uint8Array> {
        if (entry.bytes !== null) {
          return entry.bytes.slice();
        }
        const bytes = await fetchBlock({ cid, deadline, signal });
        if (entry.holders > 1) {
          // A copy each, since a caller may transfer its buffer away.
          entry.bytes = bytes.slice();
        }
        return bytes;
      }
      return pool
        .call(fetchOnce, { pool: `get:${cid}`, ...(signal !== undefined ? { signal } : {}) })
        .catch((error: unknown) => {
          throw signal?.aborted === true ? abortError(cid, error) : error;
        })
        .finally(() => {
          entry.holders -= 1;
          if (entry.holders === 0) {
            shared.delete(cid);
          }
          stop();
        });
    },
  };
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
    ABORT_ERROR_NAME,
  );
}
