// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A light client answers `operationInaccessible` just after syncing, before any peer served the proof. The raw client
// does not retry it as papi's observable client does. A server also refuses an operation while its follow has too many
// running. A read retries for 30 s from when it is asked for, queueing for an operation slot included, so a read no peer
// serves fails however long each attempt takes.

import { OperationInaccessibleError, OperationLimitError } from '@polkadot-api/substrate-client';
import { createAsyncTaskPool } from '@dotli/shared';

const RETRY_WINDOW_MS = 30_000;

// Failures past a read's window, which end its retries.
const pastWindow = new WeakSet();

const retriedReads = createAsyncTaskPool({
  poolSize: Infinity,
  retryCount: Number.POSITIVE_INFINITY,
  retryDelay: 750,
  retryIf: error => isRetried(error) && !pastWindow.has(error),
});

/**
 * Runs `read`, and again after each `OperationInaccessibleError` or `OperationLimitError`, until 30 s on `now` have
 * passed since the call. Rejects with `read`'s last error.
 */
export function readWithRetry<T>(read: () => Promise<T>, now: () => number): Promise<T> {
  const started = now();
  return retriedReads.call(async () => {
    try {
      return await read();
    } catch (error) {
      if (isRetried(error) && now() - started >= RETRY_WINDOW_MS) {
        pastWindow.add(error);
      }
      throw error;
    }
  });
}

function isRetried(error: unknown): error is OperationInaccessibleError | OperationLimitError {
  return error instanceof OperationInaccessibleError || error instanceof OperationLimitError;
}
