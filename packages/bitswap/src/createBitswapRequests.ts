// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The `bitswap_v1_get` requests of the client's fetches: each request's id, wait and timeout, the reading of its reply,
// and the retries of a fetch until it gets its block or runs out of budget.

import { isResponse, type JsonRpcConnection, type JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { TIMEOUTS } from '@dotli/config';
import { createReporter } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createPendingReplies,
  fromHex,
  isChainHaltedRpcError,
  listen,
  noop,
  serializeError,
  setErrorName,
  toError,
  type Timers,
} from '@dotli/shared';

import { BITSWAP_ERRORS, createAbortError, errorCode, withCode } from './errors.js';

const report = createReporter({ flow: 'content' });

type Params = {
  /** The clock and timers the budget, the per-call timeout and the retry waits run on. */
  timers: Timers;
};

type FetchBlockParams = {
  /** The block to fetch. */
  cid: string;
  /** The time the whole fetch must end by, on the client's clock. */
  deadline: number;
  /** Stops the fetch when it fires. */
  signal: AbortSignal | undefined;
  /** The Bulletin connection the requests go out on, whose replies `hearReply` hears. */
  connection: JsonRpcConnection;
};

// `bitswap_v1_get` error codes. Anything else, an invalid CID included, is terminal.
const ERROR_FAIL = -32810;
const ERROR_FAIL_RETRY = -32811;
const ERROR_FAIL_BACKOFF = -32812;

/** The requests of a bitswap client, each paired with its reply. */
export function createBitswapRequests({ timers }: Params) {
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

  return {
    /**
     * Fetches the block `cid` names, one attempt at a time. Rejects with an abort error when `signal` fires, and with a
     * coded error when the retries or the budget run out.
     */
    fetchBlock,
    /** Settles the request a reply on the connection answers. Ignores any other message. Never throws. */
    hearReply,
  };

  function fetchBlock({ cid, deadline, signal, connection }: FetchBlockParams): Promise<Uint8Array> {
    // Separate counters, so early -32812s cannot pin discovery retries at the backoff cap.
    let made = 0;
    let discovery = 0;
    let transient = 0;

    async function attempt(): Promise<Uint8Array> {
      made += 1;
      const remaining = deadline - timers.now();
      if (remaining <= 0) {
        throw setErrorName(
          new Error(
            `bitswap_v1_get(${cid}): timed out after ${String(TIMEOUTS.BITSWAP_TOTAL_BUDGET)}ms (${String(made - 1)} attempts made)`,
          ),
          BITSWAP_ERRORS.TIMEOUT,
        );
      }
      try {
        return await sendOnce(cid, Math.min(60_000, remaining), { signal, connection });
      } catch (error) {
        const code = errorCode(error);
        let backoff: number;
        if (code === ERROR_FAIL) {
          discovery += 1;
          // smoldot calls -32810 permanent, but it only means the peers connected at that instant lacked the block,
          // so a retry meets a larger set. Counted in attempts, not time, which slow -32812 runs would drain.
          if (discovery > 8) {
            throw withCode(
              setErrorName(
                new Error(
                  `bitswap_v1_get(${cid}): provider discovery exhausted after ${String(discovery)} failures (${String(made)} attempts made): ${serializeError(error)}`,
                ),
                BITSWAP_ERRORS.NOT_FOUND,
              ),
              code,
            );
          }
          backoff = discovery;
        } else if (code === ERROR_FAIL_RETRY || code === ERROR_FAIL_BACKOFF) {
          transient += 1;
          backoff = transient;
        } else {
          throw toError(error);
        }
        // The 1ms floor keeps a nearly spent budget off a zero delay. The deadline check then ends the fetch.
        const delay = Math.min(5_000, 500 * 2 ** Math.min(backoff - 1, 4), Math.max(1, deadline - timers.now()));
        // Expected while providers are found, so a breadcrumb. The final failure goes back to the caller.
        report.log.event('Bitswap retry', { cid, attempt: made, code, delay_ms: delay });
        throw new RetryLater(delay, error);
      }
    }

    return pool.call(attempt, { pool: `fetch:${cid}`, ...(signal !== undefined ? { signal } : {}) });
  }

  /** One request for `cid`, waited on for `timeoutMs` at most. */
  function sendOnce(
    cid: string,
    timeoutMs: number,
    { signal, connection }: Pick<FetchBlockParams, 'signal' | 'connection'>,
  ): Promise<Uint8Array> {
    // `addEventListener` never fires on a signal that is already aborted.
    if (signal?.aborted === true) {
      return Promise.reject(createAbortError(cid));
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
              replies.reject(id, createAbortError(cid));
            },
          });
    const reply = replies.wait(id);
    try {
      connection.send({ jsonrpc: '2.0', id, method: 'bitswap_v1_get', params: [cid] });
    } catch (error) {
      replies.reject(id, toError(error));
    }
    // Every exit shares one teardown, since the caller's signal outlives the call and would collect listeners.
    return reply.finally(() => {
      timers.clearTimeout(timer);
      stopListening();
    });
  }

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
}

/** A failure worth another attempt once `delayMs` has passed. */
class RetryLater extends Error {
  readonly delayMs: number;

  constructor(delayMs: number, cause: unknown) {
    super('bitswap_v1_get: retrying', { cause });
    this.delayMs = delayMs;
  }
}
