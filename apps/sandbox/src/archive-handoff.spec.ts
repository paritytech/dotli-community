// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TIMEOUTS } from '@dotli/config';
import { packArchive } from '@dotli/content';

import { handOverArchive } from './archive-handoff.js';
import { SANDBOX_ERRORS } from './errors.js';

/** Stands in for the controlling worker, keeping the reply port each handoff sends. */
function fakeWorker(): { postMessage: (message: unknown, transfer: Transferable[]) => void; ports: MessagePort[] } {
  const ports: MessagePort[] = [];
  return {
    ports,
    postMessage: (_message, transfer) => {
      const port = transfer.find(item => typeof (item as Partial<MessagePort>).postMessage === 'function');
      if (port !== undefined) {
        ports.push(port as MessagePort);
      }
    },
  };
}

/** The page-wide channel, counting the listeners still attached to it. */
class CountingChannel extends EventTarget {
  listening = 0;
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    this.listening += 1;
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    this.listening -= 1;
    super.removeEventListener(...args);
  }
}

function archive(): ReturnType<typeof packArchive> {
  return packArchive({ 'index.html': new TextEncoder().encode('<html></html>') });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('archive handoff to the service worker', () => {
  it('As a sandbox user, I hand my archive to the worker and the load continues once it acknowledges this handoff', async () => {
    // Given
    const worker = fakeWorker();
    const handoff = handOverArchive(worker, archive(), null);

    // When
    worker.ports[0]?.postMessage({ type: 'ARCHIVE_READY' });

    // Then
    await expect(handoff).resolves.toBeUndefined();
  });

  it('As a sandbox user, I hand over an archive the worker refuses and the load fails with its reason', async () => {
    // Given
    const worker = fakeWorker();
    const handoff = handOverArchive(worker, archive(), null);

    // When
    worker.ports[0]?.postMessage({ type: 'ARCHIVE_ERROR', reason: 'SET_ARCHIVE missing packed/index payload' });

    // Then
    await expect(handoff).rejects.toThrow('Service worker rejected archive: SET_ARCHIVE missing packed/index payload');
  });

  it('As a sandbox user, I retry after a handoff timed out and a late answer to the old one does not settle the retry', async () => {
    // Given an earlier handoff the page gave up on
    vi.useFakeTimers();
    const worker = fakeWorker();
    const first = handOverArchive(worker, archive(), null);
    const firstGaveUp = expect(first).rejects.toThrow(SANDBOX_ERRORS.SW_ARCHIVE_NOT_ACKNOWLEDGED);
    vi.advanceTimersByTime(TIMEOUTS.SW_ARCHIVE_ACK);
    await firstGaveUp;
    const retry = handOverArchive(worker, archive(), null);

    // When the worker answers the old handoff late, then refuses the retry
    worker.ports[0]?.postMessage({ type: 'ARCHIVE_READY' });
    worker.ports[1]?.postMessage({ type: 'ARCHIVE_ERROR', reason: 'second' });

    // Then the retry settles on its own answer
    await expect(retry).rejects.toThrow('Service worker rejected archive: second');
  });

  it('As a sandbox user, I wait on a worker that never answers and the load fails naming how long it waited', async () => {
    // Given
    vi.useFakeTimers();
    const worker = fakeWorker();
    const handoff = handOverArchive(worker, archive(), null);
    const gaveUp = expect(handoff).rejects.toThrow(
      `Service worker did not acknowledge archive within ${String(TIMEOUTS.SW_ARCHIVE_ACK / 1000)}s`,
    );

    // When
    vi.advanceTimersByTime(TIMEOUTS.SW_ARCHIVE_ACK);

    // Then
    await gaveUp;
  });

  it('As a sandbox user on the first load after a deploy, a worker from the previous release still acknowledges my archive', async () => {
    // Given a worker that ignores the port and answers on the page-wide channel
    const worker = fakeWorker();
    const pageChannel = new EventTarget();
    const handoff = handOverArchive(worker, archive(), pageChannel);

    // When
    pageChannel.dispatchEvent(new MessageEvent('message', { data: { type: 'ARCHIVE_READY' } }));

    // Then
    await expect(handoff).resolves.toBeUndefined();
  });

  it('As a sandbox user, I hand my archive to a worker that throws on post and the load fails at once with that cause and nothing left waiting', async () => {
    // Given a worker whose post throws, and the page-wide channel an older worker answers on
    vi.useFakeTimers();
    const failure = new DOMException('could not clone', 'DataCloneError');
    const worker = {
      postMessage: () => {
        throw failure;
      },
    };
    const pageChannel = new CountingChannel();

    // When
    const handoff = handOverArchive(worker, archive(), pageChannel);

    // Then
    await expect(handoff).rejects.toMatchObject({ cause: failure });
    expect(vi.getTimerCount()).toBe(0);
    expect(pageChannel.listening).toBe(0);
  });
});
