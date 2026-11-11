// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
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
  return {
    /** The worker's own status, which a case ends. */
    workerStatus,
    /** The tab's one watch of it. */
    status: watchWorkerStatus({ transport: toWorker, onReady: () => undefined }),
    /** Settles once the watch's subscription reached the worker. Never rejects. */
    subscribed,
  };
}

describe('the worker status', () => {
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
