// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { captureException } from '@dotli/metrics';
import { isRecord } from '@dotli/shared';

import { APP_SERVICE_WORKER_MESSAGES } from './appServiceWorkerMessages.js';

/**
 * Captures each archive failure the service worker reports to the page. Call once, and for the whole page, since these
 * arrive after the load, often after the dApp replaced this document. Does nothing without a `container`. Never throws.
 */
export function listenForArchiveFailures(container: ServiceWorkerContainer | null): void {
  if (container === null) {
    return;
  }
  container.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isArchiveFailure(message)) {
      return;
    }
    const error = new Error(typeof message.message === 'string' ? message.message : 'unknown archive failure');
    if (typeof message.name === 'string' && message.name !== '') {
      error.name = message.name;
    }
    captureException(error, {
      flow: 'content',
      step: message.stage === 'restore' ? 'sw_restore' : 'sw_persist',
      tags: { surface: 'app_sw' },
    });
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
