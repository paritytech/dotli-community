// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference lib="webworker" />

import { getErrorMessage, getErrorName } from '@dotli/shared';

import { APP_SERVICE_WORKER_MESSAGES } from './appServiceWorkerMessages.js';

type Params = {
  /** The pages told of the failure. */
  clients: readonly Client[];
  /** Whether keeping the archive or reading it back failed. */
  stage: 'persist' | 'restore';
  /** The failure, reported by its cause when it wraps one. */
  error: unknown;
};

/**
 * Tells each of `clients` that the archive could not be kept or read back. The worker has no error reporting, and a
 * failed write otherwise shows only when a restart has nothing to serve. Never throws: a post that fails is logged, and
 * the other clients still hear.
 */
export function reportArchiveFailure({ clients, stage, error }: Params): void {
  // An error that wraps another is reported by its cause, which names the failure better than the wrapper.
  const shown = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const message = {
    type: APP_SERVICE_WORKER_MESSAGES.ARCHIVE_FAILURE,
    stage,
    name: getErrorName(shown) ?? 'NonErrorThrow',
    message: getErrorMessage(shown),
  } as const;
  for (const client of clients) {
    try {
      client.postMessage(message);
    } catch (postError: unknown) {
      // eslint-disable-next-line no-console -- the worker has no logger, and this failure cannot reach a page
      console.error('Failed to report the archive failure to a page:', postError);
    }
  }
}
