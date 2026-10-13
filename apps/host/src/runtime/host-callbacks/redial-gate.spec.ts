// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRedialGate } from './redial-gate.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRedialGate', () => {
  it('As a product whose chain halted, I redial at once the first time', () => {
    // Given
    const gate = createRedialGate();

    // When
    gate.noteHalt();

    // Then
    expect(gate.tryDial()).toBe(true);
  });

  it('As a product whose rebuilt chain keeps halting, I wait twice as long before each redial as before the last', () => {
    // Given: a first redial that went at once and halted again
    const gate = createRedialGate();
    gate.noteHalt();
    gate.tryDial();
    gate.noteHalt();

    // When
    const atOnce = gate.tryDial();
    vi.advanceTimersByTime(1_000);
    const afterASecond = gate.tryDial();
    gate.noteHalt();
    vi.advanceTimersByTime(1_999);
    const beforeTwoSeconds = gate.tryDial();
    vi.advanceTimersByTime(1);
    const atTwoSeconds = gate.tryDial();

    // Then
    expect([atOnce, afterASecond, beforeTwoSeconds, atTwoSeconds]).toEqual([false, true, false, true]);
  });

  it('As a product whose chain stayed up past the longest wait, I redial at once again after a later halt', () => {
    // Given: a chain redialed after halting a few times, so a halt now still waits at 3999 ms
    const gate = createRedialGate();
    for (let halts = 0; halts < 3; halts += 1) {
      gate.noteHalt();
      vi.advanceTimersByTime(30_000);
      gate.tryDial();
    }
    gate.noteHalt();
    vi.advanceTimersByTime(3_999);
    const whileTheWaitHadGrown = gate.tryDial();
    // and the chain then stays up for longer than the longest wait since its last dial
    vi.advanceTimersByTime(30_001);

    // When
    gate.noteHalt();
    const afterTheUptime = gate.tryDial();

    // Then
    expect([whileTheWaitHadGrown, afterTheUptime]).toEqual([false, true]);
  });
});
