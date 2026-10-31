// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { protocolSchema } from '@dotli/protocol';
import { createDeferred } from '@dotli/shared';
import { catchError } from '@dotli/shared/testing';
import { ok } from '@dotli/transport';
import { closeHostLinks, linkHost } from './testing/linkHost.js';
import { serveWorkerStatus } from './testing/serveWorkerStatus.js';
import { watchWorkerStatus, type WorkerEnd } from './watchWorkerStatus.js';

afterEach(() => {
  closeHostLinks();
});

/** A tab's watch of a worker status, served on the other end of its link. */
function watchStatus() {
  const { serving: worker, host: toWorker } = linkHost();
  const { workerStatus, subscribed } = serveWorkerStatus(worker);
  worker.handleRequest(protocolSchema.sections.frame.heartbeat, () => ok());
  return {
    /** The worker's own status, which a case ends. */
    workerStatus,
    /** The tab's one watch of it. */
    status: watchWorkerStatus({ transport: toWorker, onReady: () => undefined }),
    /** Settles once the watch's subscription reached the worker. Never rejects. */
    subscribed,
    /** Settles once a request went to the worker and back, so all the worker sent before it has arrived. */
    roundTrip,
  };

  async function roundTrip(): Promise<void> {
    await toWorker.request(protocolSchema.sections.frame.heartbeat, undefined);
  }
}

describe('the worker status', () => {
  it('As a tab, I remove a listener of my worker status and only the listeners still there hear it end', async () => {
    // Given a watched worker status with two listeners
    const { workerStatus, status, subscribed } = watchStatus();
    const left: WorkerEnd[] = [];
    const stayed = createDeferred<WorkerEnd>();
    const removeLeaving = status.onEnd(end => {
      left.push(end);
    });
    status.onEnd(stayed.resolve);
    await subscribed;

    // When one listener leaves, and the worker then ends the status
    removeLeaving();
    workerStatus.interrupt(ok());

    // Then only the listener that stayed heard the end
    expect(await stayed.promise).toEqual({ kind: 'interrupt', outcome: ok() });
    expect(left).toEqual([]);
  });

  it('As a tab, I listen to my worker status after it ended and hear the end at once, and my removal does nothing', async () => {
    // Given a worker status that has ended
    const { workerStatus, status, subscribed } = watchStatus();
    const ended = createDeferred<WorkerEnd>();
    status.onEnd(ended.resolve);
    await subscribed;
    workerStatus.interrupt(ok());
    await ended.promise;
    const late: WorkerEnd[] = [];

    // When a late listener comes, and removes itself
    const removeLate = status.onEnd(end => {
      late.push(end);
    });
    const thrown = catchError(removeLate);

    // Then it heard the end at once, and its removal threw nothing
    expect(late).toEqual([{ kind: 'interrupt', outcome: ok() }]);
    expect(thrown).toBeUndefined();
  });

  it('As a tab that stopped watching the worker, I hear no end after dispose', async () => {
    // Given a watched worker status with a listener
    const { workerStatus, status, subscribed, roundTrip } = watchStatus();
    const heard: WorkerEnd[] = [];
    status.onEnd(end => {
      heard.push(end);
    });
    await subscribed;

    // When the tab stops watching twice, and the worker then ends the status, with a round trip around the end
    status.dispose();
    const thrown = catchError(() => {
      status.dispose();
    });
    await roundTrip();
    workerStatus.interrupt(ok());
    await roundTrip();

    // Then no listener heard an end, and the second dispose threw nothing
    expect(heard).toEqual([]);
    expect(thrown).toBeUndefined();
  });

  it('As a tab whose worker status ended, I stop watching it and nothing throws', async () => {
    // Given a watched worker status that ended
    const { workerStatus, status, subscribed } = watchStatus();
    const ended = createDeferred<WorkerEnd>();
    status.onEnd(ended.resolve);
    await subscribed;
    workerStatus.interrupt(ok());
    await ended.promise;

    // When the tab stops watching it
    const thrown = catchError(() => {
      status.dispose();
    });

    // Then nothing throws
    expect(thrown).toBeUndefined();
  });
});
