// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { listenForChunkFailures } from './chunk-failures.js';
import type { ShowNotification } from './notification.js';

type Notice = Parameters<ShowNotification>[0];

/** Vite's preload helper reporting a dynamic import that failed. */
function preloadError(target: EventTarget, payload?: unknown): void {
  target.dispatchEvent(Object.assign(new Event('vite:preloadError'), { payload }));
}

describe('listenForChunkFailures', () => {
  it('As a visitor after a deploy, a chunk that fails to load offers a reload in an error notice and is counted', () => {
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
    const notices: Notice[] = [];
    let reloads = 0;
    onTestFinished(
      listenForChunkFailures({
        target,
        notify: notice => notices.push(notice),
        reload: () => {
          reloads += 1;
        },
      }),
    );
    const failure = new TypeError('Failed to fetch dynamically imported module');

    // When
    preloadError(target, failure);
    notices[0]?.action?.onClick();

    // Then
    expect(notices).toMatchObject([{ label: 'Asset failed to load', tone: 'err', dismissMs: 0 }]);
    expect(reported).toEqual([failure]);
    expect(metrics.counted('chunk.preload')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
    expect(reloads).toBe(1);
  });

  it('As a visitor, a failure that comes without its error is still reported and offered a reload', () => {
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
    const notices: Notice[] = [];
    onTestFinished(
      listenForChunkFailures({
        target,
        notify: notice => notices.push(notice),
        reload: () => undefined,
      }),
    );

    // When
    preloadError(target);

    // Then
    expect(notices).toHaveLength(1);
    expect(reported).toEqual([new Error('vite:preloadError')]);
    expect(metrics.counted('chunk.preload')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it('As a page that stopped listening, a later chunk failure offers nothing', () => {
    // Given
    const target = new EventTarget();
    const notices: Notice[] = [];
    const stop = listenForChunkFailures({
      target,
      notify: notice => notices.push(notice),
      reload: () => undefined,
    });

    // When
    stop();
    preloadError(target, new Error('late'));

    // Then
    expect(notices).toEqual([]);
  });
});
