// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fetches blocks with `bitswap_v1_get` over one Bulletin connection to the protocol frame, redialled after a halt.

import { isResponse } from '@polkadot-api/json-rpc-provider';
import type { JsonRpcConnection, JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { CHAIN_HALTED_ERROR_DATA } from '@dotli/chains';
import type { RemoteChainProvider } from '@dotli/protocol';
import { createAsyncTaskPool, fromHex, log, named, serializeError } from '@dotli/shared';

import { BITSWAP_ERRORS } from './errors.js';

// `bitswap_v1_get` error codes. Anything else, an invalid CID included, is terminal.
const ERR_FAIL = -32810;
const ERR_FAIL_RETRY = -32811;
const ERR_FAIL_BACKOFF = -32812;

/** Marks a local abort by name, since any numeric code outside the JSON-RPC reserved range could be the chain's. */
const ABORT_ERROR_NAME = 'AbortError';

const PER_CALL_TIMEOUT_MS = 60_000;
const TOTAL_BUDGET_MS = 180_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5_000;

// smoldot calls -32810 permanent, but it only means the peers connected at that instant lacked the block,
// so a retry meets a larger set. Counted in attempts, not time, which slow -32812 runs would drain.
const DISCOVERY_RETRIES = 8;

export interface BitswapClientDeps {
  /** The Bulletin chain's provider, read at each dial, or null when the protocol frame does not serve Bulletin. */
  provider: () => RemoteChainProvider | null;
}

export interface BitswapClient {
  /**
   * Fetches one block. Pass `signal` from anything that can be torn down, since a retrying call runs for minutes. A
   * second call for a CID already being fetched waits for that fetch and gets a copy of its bytes.
   */
  get(cid: string, signal?: AbortSignal): Promise<Uint8Array>;
}

interface PendingResolver {
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
}

/** A failure worth another attempt once `delayMs` has passed. */
class RetryLater extends Error {
  readonly delayMs: number;

  constructor(delayMs: number, cause: unknown) {
    super('bitswap_v1_get: retrying', { cause });
    this.delayMs = delayMs;
  }
}

/** The retry state of one fetch, kept across the pool's attempts. */
interface FetchAttempts {
  readonly deadline: number;
  made: number;
  discovery: number;
  transient: number;
}

/** Callers of one CID and the bytes its fetch left for those still waiting. */
interface SharedFetch {
  holders: number;
  bytes: Uint8Array | null;
}

function withCode<E extends Error>(err: E, code: number): E {
  (err as { code?: number }).code = code;
  return err;
}

function errorCode(err: unknown): number | null {
  const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'number' ? code : null;
}

function abortError(cid: string, cause?: unknown): Error {
  return named(
    new Error(`bitswap_v1_get(${cid}): aborted`, cause === undefined ? undefined : { cause }),
    ABORT_ERROR_NAME,
  );
}

export function createBitswapClient({ provider }: BitswapClientDeps): BitswapClient {
  const pending = new Map<number, PendingResolver>();
  const shared = new Map<string, SharedFetch>();
  let nextId = 1;
  let connection: JsonRpcConnection | null = null;
  // Size 1 per name: one fetch per CID at a time, and one attempt at a time within it.
  const pool = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryIf: error => error instanceof RetryLater,
    retryDelay: (_retry, error) => (error as RetryLater).delayMs,
  });

  function dial(): JsonRpcConnection {
    if (connection !== null) {
      return connection;
    }
    const bulletin = provider();
    if (bulletin === null) {
      throw named(new Error('Bulletin is not in the supported chain set'), BITSWAP_ERRORS.UNAVAILABLE);
    }
    const opened = bulletin(
      (message: JsonRpcMessage) => {
        if (!isResponse(message) || typeof message.id !== 'number') {
          return;
        }
        const entry = pending.get(message.id);
        if (entry === undefined) {
          return;
        }
        pending.delete(message.id);
        if ('error' in message) {
          const err = named(
            new Error(`bitswap_v1_get failed (code=${String(message.error.code)}): ${message.error.message}`),
            BITSWAP_ERRORS.RPC,
          );
          // A halt answer arrives before `onHalt` drops the connection, so the retry redials a rebuilt chain.
          const halted = message.error.data === CHAIN_HALTED_ERROR_DATA;
          entry.reject(withCode(err, halted ? ERR_FAIL_RETRY : message.error.code));
          return;
        }
        if (typeof message.result !== 'string') {
          entry.reject(
            named(
              new Error(`bitswap_v1_get: expected hex string result, got ${typeof message.result}`),
              BITSWAP_ERRORS.RPC,
            ),
          );
          return;
        }
        // Parsed once here, so the sandbox gets a transferred buffer instead of a cloned hex string.
        const hex = message.result;
        entry.resolve(fromHex(hex));
      },
      reason => {
        // The next attempt redials. Requests the halt never answered are rejected here, and a halt from a replaced
        // connection must not touch its successor.
        if (connection !== opened) {
          return;
        }
        connection = null;
        for (const [id, entry] of pending) {
          pending.delete(id);
          const err = named(new Error('Bulletin connection halted'), BITSWAP_ERRORS.CONNECTION);
          // A halted chain is rebuilt on reconnect, so it is retried. A dead frame is fatal.
          entry.reject(reason === 'chain' ? withCode(err, ERR_FAIL_RETRY) : err);
        }
      },
    );
    connection = opened;
    return opened;
  }

  function sendOnce(cid: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const id = nextId++;
    const conn = dial();
    return new Promise<Uint8Array>((resolve, reject) => {
      // `addEventListener` never fires on a signal that is already aborted.
      if (signal?.aborted === true) {
        reject(abortError(cid));
        return;
      }
      // Every exit shares one teardown, since the caller's signal outlives the call and would collect listeners.
      const cleanup = (): void => {
        clearTimeout(timer);
        pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          withCode(
            named(
              new Error(`bitswap_v1_get(${cid}): per-call timed out after ${String(timeoutMs)}ms`),
              BITSWAP_ERRORS.TIMEOUT,
            ),
            ERR_FAIL_RETRY,
          ),
        );
      }, timeoutMs);
      // smoldot cannot cancel an issued request, so the entry is dropped and its late reply finds no slot.
      function onAbort(): void {
        cleanup();
        reject(abortError(cid));
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: bytes => {
          cleanup();
          resolve(bytes);
        },
        reject: err => {
          cleanup();
          reject(err);
        },
      });
      conn.send({ jsonrpc: '2.0', id, method: 'bitswap_v1_get', params: [cid] });
    });
  }

  /** What to do after a failed attempt: a `RetryLater` with its wait, or the failure the fetch ends with. */
  function afterFailure(cid: string, err: unknown, attempts: FetchAttempts): Error {
    const code = errorCode(err);
    // Separate counters, so early -32812s cannot pin discovery retries at the backoff cap.
    let backoffAttempt: number;
    if (code === ERR_FAIL) {
      attempts.discovery += 1;
      if (attempts.discovery > DISCOVERY_RETRIES) {
        return withCode(
          named(
            new Error(
              `bitswap_v1_get(${cid}): provider discovery exhausted after ${String(attempts.discovery)} failures (${String(attempts.made)} attempts made): ${serializeError(err)}`,
            ),
            BITSWAP_ERRORS.NOT_FOUND,
          ),
          code,
        );
      }
      backoffAttempt = attempts.discovery;
    } else if (code === ERR_FAIL_RETRY || code === ERR_FAIL_BACKOFF) {
      attempts.transient += 1;
      backoffAttempt = attempts.transient;
    } else {
      return err instanceof Error ? err : new Error(serializeError(err), { cause: err });
    }
    // The 1ms floor keeps a nearly spent budget off a zero delay. The deadline check then ends the fetch.
    const delay = Math.min(
      BACKOFF_CAP_MS,
      BACKOFF_BASE_MS * 2 ** Math.min(backoffAttempt - 1, 4),
      Math.max(1, attempts.deadline - Date.now()),
    );
    // Expected while providers are found, so a breadcrumb. The final failure goes back to the caller.
    log.event('Bitswap retry', { flow: 'content', cid, attempt: attempts.made, code, delay_ms: delay });
    return new RetryLater(delay, err);
  }

  function fetchBlock(cid: string, deadline: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const attempts: FetchAttempts = { deadline, made: 0, discovery: 0, transient: 0 };
    const attempt = async (): Promise<Uint8Array> => {
      attempts.made += 1;
      const remaining = attempts.deadline - Date.now();
      if (remaining <= 0) {
        throw named(
          new Error(
            `bitswap_v1_get(${cid}): timed out after ${String(TOTAL_BUDGET_MS)}ms (${String(attempts.made - 1)} attempts made)`,
          ),
          BITSWAP_ERRORS.TIMEOUT,
        );
      }
      try {
        return await sendOnce(cid, Math.min(PER_CALL_TIMEOUT_MS, remaining), signal);
      } catch (err) {
        throw afterFailure(cid, err, attempts);
      }
    };
    return pool.call(attempt, { pool: `fetch:${cid}`, ...(signal !== undefined ? { signal } : {}) });
  }

  return {
    get(cid, signal) {
      // Taken at the call, so a caller queued behind another fetch of the CID spends its own budget while it waits.
      const deadline = Date.now() + TOTAL_BUDGET_MS;
      const entry = shared.get(cid) ?? { holders: 0, bytes: null };
      shared.set(cid, entry);
      entry.holders += 1;
      // Idempotent: a call queued behind a fetch of the same CID finds its bytes and returns them.
      const once = async (): Promise<Uint8Array> => {
        if (entry.bytes !== null) {
          return entry.bytes.slice();
        }
        const bytes = await fetchBlock(cid, deadline, signal);
        if (entry.holders > 1) {
          // A copy each, since a caller may transfer its buffer away.
          entry.bytes = bytes.slice();
        }
        return bytes;
      };
      return pool
        .call(once, { pool: `get:${cid}`, ...(signal !== undefined ? { signal } : {}) })
        .catch((err: unknown) => {
          throw signal?.aborted === true ? abortError(cid, err) : err;
        })
        .finally(() => {
          entry.holders -= 1;
          if (entry.holders === 0) {
            shared.delete(cid);
          }
        });
    },
  };
}
