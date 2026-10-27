// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createReloadOffer } from './createReloadOffer.js';
import { listenForChunkFailures } from './listenForChunkFailures.js';
import type { NotificationParams } from './createNotifier.js';

/** Vite's preload helper reporting a dynamic import that failed. */
function dispatchPreloadError(target: EventTarget, payload?: unknown): void {
  target.dispatchEvent(Object.assign(new Event('vite:preloadError'), { payload }));
}

describe('listenForChunkFailures', () => {
  it('As a visitor after a deploy, I meet a chunk that fails to load and get a reload offer in an error notice, and the failure is counted', () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const reported: unknown[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: () => undefined,
        expected: error => {
          reported.push(error);
        },
      }),
    );
    const target = new EventTarget();
    const notices: NotificationParams[] = [];
    let reloads = 0;
    onTestFinished(
      listenForChunkFailures({
        target,
        offerReload: createReloadOffer({
          notify: notice => notices.push(notice),
          reload: () => {
            reloads += 1;
          },
        }),
      }),
    );
    const failure = new TypeError('Failed to fetch dynamically imported module');

    // When
    dispatchPreloadError(target, failure);
    notices[0]?.action?.onClick();

    // Then
    expect(notices).toMatchObject([{ label: 'Asset failed to load', tone: 'err', dismissMs: 0 }]);
    expect(reported).toEqual([failure]);
    expect(metrics.counted('chunk.preload')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
    expect(reloads).toBe(1);
  });

  it('As a visitor, I meet a failure that comes without its error and it is still reported and offered a reload', () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const reported: unknown[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: () => undefined,
        expected: error => {
          reported.push(error);
        },
      }),
    );
    const target = new EventTarget();
    const notices: NotificationParams[] = [];
    onTestFinished(
      listenForChunkFailures({
        target,
        offerReload: createReloadOffer({ notify: notice => notices.push(notice), reload: () => undefined }),
      }),
    );

    // When
    dispatchPreloadError(target);

    // Then
    expect(notices).toHaveLength(1);
    expect(reported).toEqual([new Error('vite:preloadError')]);
    expect(metrics.counted('chunk.preload')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it('As a page that stopped listening, I meet a later chunk failure and offer nothing', () => {
    // Given
    const target = new EventTarget();
    const notices: NotificationParams[] = [];
    const stop = listenForChunkFailures({
      target,
      offerReload: createReloadOffer({ notify: notice => notices.push(notice), reload: () => undefined }),
    });

    // When
    stop();
    dispatchPreloadError(target, new Error('late'));

    // Then
    expect(notices).toEqual([]);
  });
});
