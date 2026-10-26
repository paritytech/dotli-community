// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Hands the packed archive to the controlling service worker and waits for its answer to this handoff only.

import { SANDBOX_TIMEOUTS } from './timeouts.js';
import type { packArchive } from '@dotli/content';
import { withTimeout } from '@dotli/shared';

import { SANDBOX_ERRORS } from './errors.js';

type PackedArchive = ReturnType<typeof packArchive>;

/** The handoff message the controlling worker reads. */
export type SetArchiveMessage = {
  type: 'SET_ARCHIVE';
  /**
   * The directory of the path the page writes the product at, such as `/docs/` for `/docs/intro`. The page resolves
   * its relative URLs under it, while the archive holds every file from its root.
   */
  directory: string;
} & PackedArchive;

/** The one `ServiceWorker` method the handoff needs, so tests drive it with a stand-in. */
export type ArchiveWorker = {
  postMessage(message: unknown, transfer: Transferable[]): void;
};

/**
 * Resolves on `ARCHIVE_READY`, rejects on `ARCHIVE_ERROR` or after `timeoutMs`. The answer comes on a port of its own,
 * so a late answer to an attempt that already gave up cannot settle this one. `pagePath` is the path the product's page
 * is written at. `legacyReplies` is the page-wide channel a worker from the previous release answers on, since it
 * ignores the port.
 */
export function handOverArchive(
  worker: ArchiveWorker,
  { packed, index }: PackedArchive,
  pagePath: string,
  legacyReplies: EventTarget | null,
  timeoutMs: number = SANDBOX_TIMEOUTS.SW_ARCHIVE_ACK,
): Promise<void> {
  const channel = new MessageChannel();
  let onLegacyReply = (_event: Event): void => undefined;
  const answered = new Promise<void>((resolve, reject) => {
    const onReply = (data: unknown): void => {
      const msg = data as { type?: unknown; reason?: unknown } | null;
      if (msg?.type === 'ARCHIVE_READY') {
        resolve();
      } else if (msg?.type === 'ARCHIVE_ERROR') {
        // The real cause rather than a timeout, so the retry flow has something to act on.
        const reason = typeof msg.reason === 'string' ? msg.reason : 'unknown';
        reject(new Error(`Service worker rejected archive: ${reason}`));
      }
    };
    onLegacyReply = event => {
      onReply((event as MessageEvent).data);
    };
    channel.port1.onmessage = (event: MessageEvent) => {
      onReply(event.data);
    };
    legacyReplies?.addEventListener('message', onLegacyReply);
    const message: SetArchiveMessage = {
      type: 'SET_ARCHIVE',
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
  // Every exit closes the port and drops the page-wide listener, so a late answer finds nothing to settle.
  return withTimeout(answered, timeoutMs, () => new Error(SANDBOX_ERRORS.SW_ARCHIVE_NOT_ACKNOWLEDGED)).finally(() => {
    channel.port1.close();
    legacyReplies?.removeEventListener('message', onLegacyReply);
  });
}
