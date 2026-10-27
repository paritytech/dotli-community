// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { runWhenIdle, type IdleScheduler } from './runWhenIdle.js';

describe('runWhenIdle', () => {
  it('As the shell, I run idle work with my deadline once the browser is idle, and its cancel takes it back', () => {
    // Given a browser that offers idle callbacks
    const asked: { timeout: number }[] = [];
    const cancelled: number[] = [];
    let idle: (() => void) | undefined;
    const scheduler: IdleScheduler = {
      requestIdleCallback: (run, options) => {
        idle = run;
        asked.push(options);
        return 5;
      },
      cancelIdleCallback: handle => cancelled.push(handle),
    };
    const work = vi.fn();

    // When the work is scheduled, the browser goes idle and the work is cancelled
    const cancel = runWhenIdle(work, 2_000, { scheduler });
    idle?.();
    cancel();

    // Then
    expect(work).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([{ timeout: 2_000 }]);
    expect(cancelled).toEqual([5]);
  });
});
