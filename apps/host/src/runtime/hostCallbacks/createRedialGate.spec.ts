// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createManualTimers } from '@dotli/shared/testing';
import { createRedialGate } from './createRedialGate.js';

describe('createRedialGate', () => {
  it('As a dotli integrator, I note the first halt of a chain and its redial goes at once', () => {
    // Given
    const gate = createRedialGate({ timers: createManualTimers() });

    // When
    gate.noteHalt();
    const redial = gate.tryDial();

    // Then
    expect(redial).toBe(true);
  });

  it('As a dotli integrator, I note a rebuilt chain halting again and each redial waits twice as long as the last', async () => {
    // Given a first redial that went at once and halted again
    const timers = createManualTimers();
    const gate = createRedialGate({ timers });
    gate.noteHalt();
    gate.tryDial();
    gate.noteHalt();

    // When
    const atOnce = gate.tryDial();
    await timers.advance(1_000);
    const afterASecond = gate.tryDial();
    gate.noteHalt();
    await timers.advance(1_999);
    const beforeTwoSeconds = gate.tryDial();
    await timers.advance(1);
    const atTwoSeconds = gate.tryDial();

    // Then
    expect([atOnce, afterASecond, beforeTwoSeconds, atTwoSeconds]).toEqual([false, true, false, true]);
  });

  it('As a dotli integrator, I note a halt after the chain stayed up past the longest wait and the redial goes at once again', async () => {
    // Given a chain redialed after halting a few times, so a halt now still waits at 3999 ms
    const timers = createManualTimers();
    const gate = createRedialGate({ timers });
    for (let halts = 0; halts < 3; halts += 1) {
      gate.noteHalt();
      await timers.advance(30_000);
      gate.tryDial();
    }
    gate.noteHalt();
    await timers.advance(3_999);

    // When the wait has grown, and the chain then stays up for longer than the longest wait before it halts again
    const whileTheWaitHadGrown = gate.tryDial();
    await timers.advance(30_001);
    gate.noteHalt();
    const afterTheUptime = gate.tryDial();

    // Then
    expect([whileTheWaitHadGrown, afterTheUptime]).toEqual([false, true]);
  });
});
