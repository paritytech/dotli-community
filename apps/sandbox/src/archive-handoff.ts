// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Hands the packed archive to the controlling service worker and waits for its answer to this handoff only.

import { SANDBOX_TIMEOUTS } from './timeouts.js';
import type { packArchive } from '@dotli/content';

import { SANDBOX_ERRORS } from './errors.js';

type PackedArchive = ReturnType<typeof packArchive>;

/** The one `ServiceWorker` method the handoff needs, so tests drive it with a stand-in. */
export interface ArchiveWorker {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/**
 * Resolves on `ARCHIVE_READY`, rejects on `ARCHIVE_ERROR` or after `timeoutMs`. The answer comes on a port of its own,
 * so a late answer to an attempt that already gave up cannot settle this one. `legacyReplies` is the page-wide channel a
 * worker from the previous release answers on, since it ignores the port.
 */
export function handOverArchive(
  worker: ArchiveWorker,
  { packed, index }: PackedArchive,
  legacyReplies: EventTarget | null,
  timeoutMs: number = SANDBOX_TIMEOUTS.SW_ARCHIVE_ACK,
): Promise<void> {
  const channel = new MessageChannel();
  return new Promise<void>((resolve, reject) => {
    const settle = (error: Error | null): void => {
      clearTimeout(timer);
      channel.port1.close();
      legacyReplies?.removeEventListener('message', onLegacyReply);
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onReply = (data: unknown): void => {
      const msg = data as { type?: unknown; reason?: unknown } | null;
      if (msg?.type === 'ARCHIVE_READY') {
        settle(null);
      } else if (msg?.type === 'ARCHIVE_ERROR') {
        // The real cause rather than a timeout, so the retry flow has something to act on.
        const reason = typeof msg.reason === 'string' ? msg.reason : 'unknown';
        settle(new Error(`Service worker rejected archive: ${reason}`));
      }
    };
    const onLegacyReply = (event: Event): void => {
      onReply((event as MessageEvent).data);
    };
    const timer = setTimeout(() => {
      settle(new Error(SANDBOX_ERRORS.SW_ARCHIVE_NOT_ACKNOWLEDGED));
    }, timeoutMs);

    channel.port1.onmessage = (event: MessageEvent) => {
      onReply(event.data);
    };
    legacyReplies?.addEventListener('message', onLegacyReply);
    try {
      worker.postMessage({ type: 'SET_ARCHIVE', packed, index }, [packed, channel.port2]);
    } catch (cause) {
      // Settled here, so the timer, the port and the page-wide listener go now rather than at the timeout.
      settle(new Error(SANDBOX_ERRORS.SW_ARCHIVE_NOT_SENT, { cause }));
    }
  });
}
