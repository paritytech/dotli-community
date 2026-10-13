// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { listenForChunkFailures } from './chunk-failures.js';
import type { ShowNotification } from './notification.js';

type Notice = Parameters<ShowNotification>[0];

/** Vite's preload helper reporting a dynamic import that failed. */
function preloadError(target: EventTarget, payload?: unknown): void {
  target.dispatchEvent(Object.assign(new Event('vite:preloadError'), { payload }));
}

describe('listenForChunkFailures', () => {
  it('As a visitor after a deploy, a chunk that fails to load offers a reload in an error notice and is reported', () => {
    // Given
    const target = new EventTarget();
    const notices: Notice[] = [];
    const reported: unknown[] = [];
    let reloads = 0;
    onTestFinished(
      listenForChunkFailures({
        target,
        notify: notice => notices.push(notice),
        reload: () => {
          reloads += 1;
        },
        report: error => reported.push(error),
      }),
    );
    const failure = new TypeError('Failed to fetch dynamically imported module');

    // When
    preloadError(target, failure);
    notices[0]?.action?.onClick();

    // Then
    expect(notices).toMatchObject([{ label: 'Asset failed to load', tone: 'err', dismissMs: 0 }]);
    expect(reported).toEqual([failure]);
    expect(reloads).toBe(1);
  });

  it('As a visitor, a failure that comes without its error is still reported and offered a reload', () => {
    // Given
    const target = new EventTarget();
    const notices: Notice[] = [];
    const reported: unknown[] = [];
    onTestFinished(
      listenForChunkFailures({
        target,
        notify: notice => notices.push(notice),
        reload: () => undefined,
        report: error => reported.push(error),
      }),
    );

    // When
    preloadError(target);

    // Then
    expect(notices).toHaveLength(1);
    expect(reported).toEqual([new Error('vite:preloadError')]);
  });

  it('As a page that stopped listening, a later chunk failure offers nothing', () => {
    // Given
    const target = new EventTarget();
    const notices: Notice[] = [];
    const stop = listenForChunkFailures({
      target,
      notify: notice => notices.push(notice),
      reload: () => undefined,
      report: () => undefined,
    });

    // When
    stop();
    preloadError(target, new Error('late'));

    // Then
    expect(notices).toEqual([]);
  });
});
