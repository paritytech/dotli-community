// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// `api.whenReady()` never settles without reachable peers, so callers race a timer that names the cause.

import { DisjointError, RpcError } from '@polkadot-api/substrate-client';
import { log } from '@dotli/shared';
import type { ResolveOptions } from './resolve.js';
import { NetworkSyncTimeoutError } from './errors.js';

export function raceSyncTimeout<T>(work: Promise<T>, chain: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new NetworkSyncTimeoutError(chain, timeoutMs));
      }, timeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

/** Apply a caller's budget to a wait already bounded by `capMs`, only when it is tighter. */
export function withSyncBudget<T>(
  work: Promise<T>,
  chain: string,
  requestedMs: number | undefined,
  capMs: number,
): Promise<T> {
  if (requestedMs === undefined || requestedMs >= capMs) {
    return work;
  }
  return raceSyncTimeout(work, chain, requestedMs);
}

// The `error.data` the protocol's chain pool puts on its answer to a request
// whose chain halted under it: `CHAIN_HALTED_ERROR_DATA` in
// `packages/protocol/src/chain-halted.ts`. The resolver must not import the
// protocol package, so the value is repeated here.
const CHAIN_HALTED_ERROR_DATA = 'dotli:chain-halted';

/**
 * Whether a read failed because the chain under the resolver's client halted.
 * Each of these comes with the follow's `stop`, which has already dropped the
 * client (through `onStop`, or before its first block by never caching it), so
 * the next attempt takes a fresh lease and the pool rebuilds the chain:
 *
 * - the pool's answer to a request still in flight, marked with
 *   `CHAIN_HALTED_ERROR_DATA` (papi keeps the JSON-RPC `data` on `RpcError`);
 * - `ApiStoppedError` (`api.ts`): the follow stopped before its first block,
 *   or a read started after it stopped;
 * - papi's `DisjointError`: the same `stop` cut off an operation already
 *   running.
 */
function isChainHalt(err: unknown): boolean {
  if (err instanceof RpcError) {
    return err.data === CHAIN_HALTED_ERROR_DATA;
  }
  return err instanceof DisjointError || (err instanceof Error && err.name === 'ApiStoppedError');
}

/**
 * Attempts a read gets on chains that halt under it. A light client resuming
 * from a recent stored database sends `stop` on the follows it opened at the
 * stale head once it catches up, and can do so twice in one catch-up (DOTLI-BY),
 * so one retry is not enough. Bounded so a chain that dies instantly cannot spin
 * a caller without a deadline; one that keeps dying fails its next connect
 * instead, which the protocol context reports as fatal.
 */
const MAX_HALT_ATTEMPTS = 4;

/**
 * Run a read again on a rebuilt chain when its chain halts under it.
 * Every attempt shares the caller's original sync budget.
 */
export async function withHaltRetry<T>(opts: ResolveOptions, read: (opts: ResolveOptions) => Promise<T>): Promise<T> {
  const started = performance.now();
  const budget = opts.syncTimeoutMs;
  for (let attempt = 1; ; attempt++) {
    const attemptOpts =
      attempt === 1 || budget === undefined
        ? opts
        : { ...opts, syncTimeoutMs: Math.max(1, Math.floor(budget - (performance.now() - started))) };
    try {
      return await read(attemptOpts);
    } catch (err) {
      if (!isChainHalt(err) || attempt === MAX_HALT_ATTEMPTS) {
        throw err;
      }
      log.warn(
        `[dot.li resolve] Chain halted mid-resolution, retrying on a rebuilt chain (attempt ${String(attempt + 1)}/${String(MAX_HALT_ATTEMPTS)}): ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
}
