// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';

import { SANDBOX_TIMEOUTS } from './timeouts.js';
import { packArchive } from '@dotli/content';
import { createManualTimers } from '@dotli/shared/testing';

import { handOverArchive } from './handOverArchive.js';
import { SANDBOX_ERRORS } from './errors.js';
import { createCountingEventTarget } from './testing/createCountingEventTarget.js';

/** Stands in for the controlling worker, keeping each handoff's message and reply port. */
function createFakeWorker(): {
  postMessage: (message: unknown, transfer: Transferable[]) => void;
  messages: unknown[];
  ports: MessagePort[];
} {
  const messages: unknown[] = [];
  const ports: MessagePort[] = [];
  return {
    messages,
    ports,
    postMessage(message, transfer) {
      messages.push(message);
      const port = transfer.find(item => item instanceof MessagePort);
      if (port instanceof MessagePort) {
        ports.push(port);
      }
    },
  };
}

function packTestArchive(): ReturnType<typeof packArchive> {
  return packArchive({ 'index.html': new TextEncoder().encode('<html></html>') });
}

describe('archive handoff to the service worker', () => {
  it('As a visitor on a deep link, I open the product and my page hands over its archive with the directory it is written at', () => {
    // Given a worker that acknowledges each handoff once the test ends
    const worker = createFakeWorker();
    const handoffs: Promise<void>[] = [];
    onTestFinished(async () => {
      for (const port of worker.ports) {
        port.postMessage({ type: 'ARCHIVE_READY' });
      }
      await Promise.all(handoffs);
    });

    // When the page is written at /docs/intro, then at the root
    handoffs.push(
      handOverArchive({ worker, archive: packTestArchive(), pagePath: '/docs/intro', legacyReplies: null }),
      handOverArchive({ worker, archive: packTestArchive(), pagePath: '/', legacyReplies: null }),
    );

    // Then each handoff names the directory of its page
    expect(worker.messages).toMatchObject([
      { type: 'SET_ARCHIVE', directory: '/docs/' },
      { type: 'SET_ARCHIVE', directory: '/' },
    ]);
  });

  it('As a sandbox user, I hand my archive to the worker and the load continues once it acknowledges this handoff', async () => {
    // Given
    const worker = createFakeWorker();
    const handoff = handOverArchive({ worker, archive: packTestArchive(), pagePath: '/', legacyReplies: null });

    // When
    worker.ports[0]?.postMessage({ type: 'ARCHIVE_READY' });

    // Then
    await expect(handoff).resolves.toBeUndefined();
  });

  it('As a sandbox user, I hand over an archive the worker refuses and the load fails with its reason', async () => {
    // Given
    const worker = createFakeWorker();
    const handoff = handOverArchive({ worker, archive: packTestArchive(), pagePath: '/', legacyReplies: null });

    // When
    worker.ports[0]?.postMessage({ type: 'ARCHIVE_ERROR', reason: 'SET_ARCHIVE missing packed/index payload' });

    // Then
    await expect(handoff).rejects.toThrow('Service worker rejected archive: SET_ARCHIVE missing packed/index payload');
  });

  it('As a sandbox user, I retry after a handoff timed out and a late answer to the old one does not settle the retry', async () => {
    // Given an earlier handoff the page gave up on
    const timers = createManualTimers();
    const worker = createFakeWorker();
    const first = handOverArchive({ worker, archive: packTestArchive(), pagePath: '/', legacyReplies: null, timers });
    const firstGaveUp = expect(first).rejects.toThrow(SANDBOX_ERRORS.SW_ARCHIVE_NOT_ACKNOWLEDGED);
    await timers.advance(SANDBOX_TIMEOUTS.SW_ARCHIVE_ACK);
    const retry = handOverArchive({ worker, archive: packTestArchive(), pagePath: '/', legacyReplies: null, timers });

    // When the worker answers the old handoff late, then refuses the retry
    worker.ports[0]?.postMessage({ type: 'ARCHIVE_READY' });
    worker.ports[1]?.postMessage({ type: 'ARCHIVE_ERROR', reason: 'second' });

    // Then the first gave up on its own, and the retry settles on its own answer
    await firstGaveUp;
    await expect(retry).rejects.toThrow('Service worker rejected archive: second');
  });

  it('As a sandbox user, I wait on a worker that never answers and the load fails naming how long it waited', async () => {
    // Given
    const timers = createManualTimers();
    const worker = createFakeWorker();
    const handoff = handOverArchive({ worker, archive: packTestArchive(), pagePath: '/', legacyReplies: null, timers });
    const gaveUp = expect(handoff).rejects.toThrow(
      `Service worker did not acknowledge archive within ${String(SANDBOX_TIMEOUTS.SW_ARCHIVE_ACK / 1000)}s`,
    );

    // When
    await timers.advance(SANDBOX_TIMEOUTS.SW_ARCHIVE_ACK);

    // Then
    await gaveUp;
  });

  it('As a sandbox user on the first load after a deploy, I hand my archive to a worker from the previous release and it still acknowledges it', async () => {
    // Given a worker that ignores the port and answers on the page-wide channel
    const worker = createFakeWorker();
    const pageChannel = new EventTarget();
    const handoff = handOverArchive({ worker, archive: packTestArchive(), pagePath: '/', legacyReplies: pageChannel });

    // When
    pageChannel.dispatchEvent(new MessageEvent('message', { data: { type: 'ARCHIVE_READY' } }));

    // Then
    await expect(handoff).resolves.toBeUndefined();
  });

  it('As a sandbox user, I hand my archive to a worker that throws on post and the load fails at once with that cause and nothing left waiting', async () => {
    // Given a worker whose post throws, and the page-wide channel an older worker answers on
    const timers = createManualTimers();
    const failure = new DOMException('could not clone', 'DataCloneError');
    const worker = {
      postMessage: () => {
        throw failure;
      },
    };
    const pageChannel = createCountingEventTarget({ type: 'message' });

    // When
    const handoff = handOverArchive({
      worker,
      archive: packTestArchive(),
      pagePath: '/',
      legacyReplies: pageChannel,
      timers,
    });

    // Then
    await expect(handoff).rejects.toMatchObject({ cause: failure });
    expect(timers.countPending()).toBe(0);
    expect(pageChannel.countListening()).toBe(0);
  });
});
