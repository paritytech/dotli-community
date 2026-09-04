// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from "vitest";

/**
 * Upper bound for scenarios that assert a warm-up waits the full ready
 * allowance rather than cutting off at a per-request budget. Mirrors
 * `IFRAME_READY_TIMEOUT_MS = 240_000` (client.ts:326) plus a small margin.
 * The failure mode on drift is a test timeout, not silent passing.
 */
export const READY_SETTLE_CAP_MS = 250_000;

/**
 * Streams fake time advancement in discrete steps up to `maxMs`.
 * Yields current elapsed milliseconds. Throws if the loop runs past `maxMs`.
 */
export async function* ticker(
  maxMs: number,
  step = 10,
): AsyncGenerator<number, void, void> {
  for (let elapsed = 0; elapsed <= maxMs; elapsed += step) {
    yield elapsed;
    await vi.advanceTimersByTimeAsync(step);
  }
  throw new Error(`exceeded deadline of ${maxMs}ms`);
}

/**
 * Advance fake timers and drain the microtask turns that timers yield.
 */
export async function elapse(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/**
 * Attach rejection-absorbing handlers to a promise and return a flag reader.
 * Keeps abandoned or late-rejecting requests from leaking unhandled rejections.
 */
export function settled(promise: Promise<unknown>): () => boolean {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return () => done;
}

/**
 * Advance fake time until the promise settles, or throw if it remains
 * pending past `maxMs`.
 */
export async function settleWithin(
  promise: Promise<unknown>,
  maxMs: number,
): Promise<void> {
  const isDone = settled(promise);
  for await (const _ of ticker(maxMs)) {
    if (isDone()) {
      return;
    }
  }
}

/**
 * Advance fake time until `condition()` returns true, or throw if the
 * deadline elapses.
 */
export async function until(
  condition: () => boolean,
  maxMs: number,
): Promise<void> {
  for await (const _ of ticker(maxMs)) {
    if (condition()) {
      return;
    }
  }
}
