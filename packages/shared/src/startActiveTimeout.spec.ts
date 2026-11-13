// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { startActiveTimeout } from './startActiveTimeout.js';
import { createManualTimers } from './testing/createManualTimers.js';

/** A wait of `ms` on manual timers, with how many times it elapsed. */
function startCounted(ms: number) {
  const timers = createManualTimers();
  const wait = { elapsed: 0 };
  const stop = startActiveTimeout({
    ms,
    onElapsed: () => {
      wait.elapsed += 1;
    },
    timers,
  });
  return { timers, wait, stop };
}

describe('startActiveTimeout', () => {
  it('As a page that stays active, I wait the active time and hear it elapse once', async () => {
    // Given
    const { timers, wait } = startCounted(1_000);

    // When
    await timers.advance(999);
    const beforeDue = wait.elapsed;
    await timers.advance(1);
    await timers.advance(5_000);

    // Then
    expect(beforeDue).toBe(0);
    expect(wait.elapsed).toBe(1);
  });

  it('As a page frozen past the due time, I wait a whole active time again after waking', async () => {
    // Given
    const { timers, wait } = startCounted(90_000);

    // When
    timers.freeze(300_000);
    await timers.advance(89_999);
    const beforeLastMs = wait.elapsed;
    await timers.advance(1);

    // Then
    expect(beforeLastMs).toBe(0);
    expect(wait.elapsed).toBe(1);
  });

  it('As a page in a throttled background tab, I hear a wait a second late elapse', async () => {
    // Given
    const { timers, wait } = startCounted(90_000);

    // When
    timers.freeze(91_000);
    await timers.advance(0);

    // Then
    expect(wait.elapsed).toBe(1);
  });

  it('As a page frozen only until before the due time, I hear the wait elapse on time', async () => {
    // Given
    const { timers, wait } = startCounted(90_000);

    // When
    timers.freeze(70_000);
    await timers.advance(19_999);
    const beforeDue = wait.elapsed;
    await timers.advance(1);

    // Then the freeze counts as active runtime, since the wake finds the wait not yet due
    expect(beforeDue).toBe(0);
    expect(wait.elapsed).toBe(1);
  });

  it('As a caller, I stop a wait and it never elapses, and a later stop does nothing', async () => {
    // Given
    const { timers, wait, stop } = startCounted(1_000);

    // When
    stop();
    stop();
    await timers.advance(10_000);

    // Then
    expect(wait.elapsed).toBe(0);
  });

  it('As a caller, I stop a wait that already elapsed and nothing changes', async () => {
    // Given
    const { timers, wait, stop } = startCounted(1_000);
    await timers.advance(1_000);

    // When
    stop();
    await timers.advance(10_000);

    // Then
    expect(wait.elapsed).toBe(1);
  });

  it('As a caller, I stop a wait a freeze postponed and it never elapses', async () => {
    // Given
    const { timers, wait, stop } = startCounted(1_000);
    timers.freeze(300_000);
    await timers.advance(0);

    // When
    stop();
    await timers.advance(10_000);

    // Then
    expect(wait.elapsed).toBe(0);
  });
});
