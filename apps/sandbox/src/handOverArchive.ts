// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Hands the packed archive to the controlling service worker and waits for its answer to this handoff only.

import { APP_SERVICE_WORKER_MESSAGES } from './appServiceWorkerMessages.js';
import { SANDBOX_TIMEOUTS } from './timeouts.js';
import type { packArchive } from '@dotli/content';
import { isRecord, realTimers, withTimeout, type Timers } from '@dotli/shared';

import { SANDBOX_ERRORS } from './errors.js';

type PackedArchive = ReturnType<typeof packArchive>;

/** The handoff message the controlling worker reads. */
export type SetArchiveMessage = {
  type: typeof APP_SERVICE_WORKER_MESSAGES.SET_ARCHIVE;
  /**
   * The directory of the path the page writes the product at, such as `/docs/` for `/docs/intro`. The page resolves
   * its relative URLs under it, while the archive holds every file from its root.
   */
  directory: string;
} & PackedArchive;

/** The one `ServiceWorker` method the handoff needs. */
export type ArchiveWorker = {
  /** Posts `message`, moving the `transfer` objects to the worker. Throws when the message cannot be sent. */
  postMessage(message: unknown, transfer: Transferable[]): void;
};

type Params = {
  /** The worker that controls the page. */
  worker: ArchiveWorker;
  /** The packed archive, whose buffer moves to the worker. */
  archive: PackedArchive;
  /** The path the product's page is written at. */
  pagePath: string;
  /** How long the worker has to answer. */
  timeoutMs?: number;
  /** The timers the wait for the answer runs on. */
  timers?: Timers;
};

/**
 * Resolves on `ARCHIVE_READY`, rejects on `ARCHIVE_ERROR`, on a post that throws, or after `timeoutMs`. The answer
 * comes on a port of its own, so a late answer to an attempt that already gave up cannot settle this one.
 */
export function handOverArchive({
  worker,
  archive: { packed, index },
  pagePath,
  timeoutMs = SANDBOX_TIMEOUTS.SW_ARCHIVE_ACK,
  timers = realTimers,
}: Params): Promise<void> {
  const channel = new MessageChannel();
  const answered = new Promise<void>((resolve, reject) => {
    function onReply(data: unknown): void {
      if (!isArchiveReply(data)) {
        return;
      }
      switch (data.type) {
        case APP_SERVICE_WORKER_MESSAGES.ARCHIVE_READY:
          resolve();
          return;
        case APP_SERVICE_WORKER_MESSAGES.ARCHIVE_ERROR: {
          // The real cause rather than a timeout, so the retry flow has something to act on.
          const reason = typeof data.reason === 'string' ? data.reason : 'unknown';
          reject(new Error(`Service worker rejected archive: ${reason}`));
          return;
        }
      }
    }
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      onReply(event.data);
    };
    const message: SetArchiveMessage = {
      type: APP_SERVICE_WORKER_MESSAGES.SET_ARCHIVE,
      packed,
      index,
      directory: pagePath.slice(0, pagePath.lastIndexOf('/') + 1),
    };
    try {
      worker.postMessage(message, [packed, channel.port2]);
    } catch (cause) {
      reject(new Error(SANDBOX_ERRORS.SW_ARCHIVE_NOT_SENT, { cause }));
    }
  });
  // Every exit closes the port, so a late answer finds nothing to settle.
  return withTimeout({
    work: answered,
    ms: timeoutMs,
    timers,
    timeoutError: () => new Error(SANDBOX_ERRORS.SW_ARCHIVE_NOT_ACKNOWLEDGED),
  }).finally(() => {
    channel.port1.close();
  });
}

/** Whether a worker's message answers a handoff. Its reason stays unchecked until it is read. */
function isArchiveReply(
  data: unknown,
): data is
  | { type: typeof APP_SERVICE_WORKER_MESSAGES.ARCHIVE_READY }
  | { type: typeof APP_SERVICE_WORKER_MESSAGES.ARCHIVE_ERROR; reason?: unknown } {
  return (
    isRecord(data) &&
    (data['type'] === APP_SERVICE_WORKER_MESSAGES.ARCHIVE_READY ||
      data['type'] === APP_SERVICE_WORKER_MESSAGES.ARCHIVE_ERROR)
  );
}
