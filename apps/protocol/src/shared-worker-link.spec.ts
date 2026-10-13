// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import type { ProtocolEnvelope } from '@dotli/protocol';
import { connectSharedWorker } from './shared-worker-link.js';

const READY_TIMEOUT_MS = 30_000;

interface FakeWorker {
  worker: SharedWorker;
  /** What the iframe posted to the worker, in order. */
  posted: unknown[];
  closed: () => boolean;
  /** The worker posting `data` to the iframe. */
  fromWorker: (data: unknown) => void;
  /** The worker script failing to load. */
  failToStart: (message: string) => void;
}

function fakeWorker(): FakeWorker {
  const posted: unknown[] = [];
  let closed = false;
  const portTarget = new EventTarget();
  const port = Object.assign(portTarget, {
    postMessage: (message: unknown) => {
      posted.push(message);
    },
    start: () => undefined,
    close: () => {
      closed = true;
    },
  });
  const workerTarget = new EventTarget();
  const worker = Object.assign(workerTarget, { port }) as unknown as SharedWorker;
  return {
    worker,
    posted,
    closed: () => closed,
    fromWorker: data => {
      portTarget.dispatchEvent(new MessageEvent('message', { data }));
    },
    failToStart: message => {
      workerTarget.dispatchEvent(new ErrorEvent('error', { message }));
    },
  };
}

/** The iframe's page, which hides when the host removes the frame or the tab navigates. */
function framePage(): { target: EventTarget; hide: () => void } {
  const target = new EventTarget();
  return {
    target,
    hide: () => {
      target.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
    },
  };
}

function link(fake: FakeWorker, page = framePage(), relayed: ProtocolEnvelope[] = []): Promise<MessagePort> {
  return connectSharedWorker({
    worker: fake.worker,
    window: page.target,
    relay: envelope => relayed.push(envelope),
    readyTimeoutMs: READY_TIMEOUT_MS,
  });
}

describe('connectSharedWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a tab closed while the shared light client syncs, I tell the worker I am leaving', () => {
    // Given a worker that never says ready
    const worker = fakeWorker();
    const page = framePage();
    void link(worker, page).catch(() => undefined);

    // When the host removes the frame
    page.hide();

    // Then
    expect(worker.posted).toEqual([{ type: 'disconnect' }]);
    expect(worker.closed()).toBe(true);
  });

  it('As a tab on the shared light client, I hear the chains while the worker syncs and my frame is up once it says ready', async () => {
    // Given
    const worker = fakeWorker();
    const relayed: ProtocolEnvelope[] = [];
    const linked = link(worker, framePage(), relayed);
    const db: ProtocolEnvelope = { namespace: 'dotli:protocol', kind: 'smoldot-db', chain: 'relay', outcome: 'miss' };

    // When
    worker.fromWorker({ type: 'relay-response', envelope: db });
    worker.fromWorker({ type: 'ready' });

    // Then
    await expect(linked).resolves.toBe(worker.worker.port);
    expect(relayed).toEqual([db]);
  });

  it('As a tab whose SharedWorker fails to start, my frame fails at once with why', async () => {
    // Given
    const worker = fakeWorker();
    const linked = link(worker);

    // When
    worker.failToStart('script error');

    // Then
    await expect(linked).rejects.toThrow('SharedWorker failed to start: script error');
  });

  it('As a tab whose worker cannot sync, my frame fails with the reason the worker gave', async () => {
    // Given
    const worker = fakeWorker();
    const linked = link(worker);

    // When
    worker.fromWorker({ type: 'error', message: 'chainHead follow stopped' });

    // Then
    await expect(linked).rejects.toThrow('SharedWorker error: chainHead follow stopped');
  });

  it('As a tab whose worker never says ready, my frame fails after the ready wait', async () => {
    // Given
    const worker = fakeWorker();
    const linked = link(worker).catch((err: unknown) => err);

    // When
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);

    // Then
    await expect(linked).resolves.toMatchObject({ message: 'SharedWorker did not signal ready within timeout' });
  });

  it('As a dotli maintainer, a SharedWorker that fails after it was ready is reported, since nothing waits on it', async () => {
    // Given a worker that is ready
    const exceptions: string[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: (_err, ctx) => {
          exceptions.push(ctx.step);
        },
        expected: () => undefined,
      }),
    );
    const worker = fakeWorker();
    const linked = link(worker);
    worker.fromWorker({ type: 'ready' });
    await linked;

    // When
    worker.failToStart('late script error');

    // Then the late failure was captured once
    expect(exceptions).toEqual(['shared_worker_error']);
  });
});
