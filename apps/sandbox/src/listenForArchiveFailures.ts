// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter } from '@dotli/metrics';
import { isRecord } from '@dotli/shared';

import { APP_SERVICE_WORKER_MESSAGES } from './appServiceWorkerMessages.js';

const report = createReporter({ flow: 'content' });

/**
 * Captures each archive failure the service worker reports to the page, until the returned stop is called. Failures
 * arrive after the load, often after the dApp replaced this document. Without a `container` the stop does nothing.
 * Never throws, and the stop is safe to call twice.
 */
export function listenForArchiveFailures(
  container: Pick<ServiceWorkerContainer, 'addEventListener' | 'removeEventListener'> | null,
): () => void {
  if (container === null) {
    return () => undefined;
  }
  // Declared here, so two listens never share a listener and one stop never removes another's.
  function onMessage(event: MessageEvent<unknown>): void {
    captureArchiveFailure(event);
  }
  container.addEventListener('message', onMessage);
  return () => {
    container.removeEventListener('message', onMessage);
  };
}

/** Captures the worker's message when it reports an archive failure. Never throws. */
function captureArchiveFailure(event: MessageEvent<unknown>): void {
  const message = event.data;
  if (!isArchiveFailure(message)) {
    return;
  }
  const error = new Error(typeof message.message === 'string' ? message.message : 'unknown archive failure');
  if (typeof message.name === 'string' && message.name !== '') {
    error.name = message.name;
  }
  report.capture(error, {
    step: message.stage === 'restore' ? 'sw_restore' : 'sw_persist',
    tags: { surface: 'app_sw' },
  });
}

/** Whether a worker's message reports an archive failure. Its other fields stay unchecked until they are read. */
function isArchiveFailure(data: unknown): data is {
  type: typeof APP_SERVICE_WORKER_MESSAGES.ARCHIVE_FAILURE;
  stage?: unknown;
  name?: unknown;
  message?: unknown;
} {
  return isRecord(data) && data['type'] === APP_SERVICE_WORKER_MESSAGES.ARCHIVE_FAILURE;
}
