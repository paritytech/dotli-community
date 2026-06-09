// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Single-slot FIFO queue serializing host-side wallet-flow modals.
 *
 * host-papp already serializes the SSO wire internally, but each call also
 * opens a host modal that must not stack with another wallet flow.
 */

import { ResultAsync, type Result } from "neverthrow";

export type WalletFlowQueue = <T, E>(
  fn: () => ResultAsync<T, E>,
) => ResultAsync<T, E>;

export function createWalletFlowQueue(): WalletFlowQueue {
  let chain: Promise<unknown> = Promise.resolve();

  function enqueue<T, E>(fn: () => ResultAsync<T, E>): ResultAsync<T, E> {
    // Both then branches run fn so a previous rejection cannot stall the queue.
    const run = (): ResultAsync<T, E> => fn();
    const next: Promise<Result<T, E>> = chain.then(run, run);
    chain = next;
    return ResultAsync.fromSafePromise(next).andThen((r) => r);
  }

  return enqueue;
}

export const queueWalletFlow: WalletFlowQueue = createWalletFlowQueue();
