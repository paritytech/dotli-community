// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createManualTimers } from '@dotli/shared/testing';
import { createChainRedial } from './createChainRedial.js';
import type { ConnectionStatus } from './transportHooks.js';

type Params = {
  /** Whether the frame is down, false by default. */
  frameDown?: boolean;
};

describe('createChainRedial', () => {
  it('As a chain pool, I redial a chain at once after its first halt and then only as its gate allows', () => {
    // Given a chain that halted once
    const { redial } = setup();
    redial.noteHalt('0xaa', 'chain');

    // When it is redialed, halts again and is redialed again
    const first = redial.tryDial('0xaa', 'chain');
    redial.noteHalt('0xaa', 'chain');
    const second = redial.tryDial('0xaa', 'chain');
    const wait = redial.waitMs('0xaa', 'chain');

    // Then the first redial goes, the second waits the gate's 1 s
    expect([first, second, wait]).toEqual([true, false, 1_000]);
  });

  it('As a chain pool, I let a halted lease join a chain another lease already rebuilt', () => {
    // Given a chain whose gate is shut, and another lease has rebuilt it
    const { redial, setStatus } = setup();
    redial.noteHalt('0xaa', 'chain');
    redial.tryDial('0xaa', 'chain');
    redial.noteHalt('0xaa', 'chain');
    setStatus('connected');

    // When the lease asks, and the chain is gone again
    const joined = redial.tryDial('0xaa', 'chain');
    const wait = redial.waitMs('0xaa', 'chain');
    setStatus('disconnected');
    const waitOnceGone = redial.waitMs('0xaa', 'chain');

    // Then the lease joins at once, and the gate still waits only its first 1 s
    expect([joined, wait, waitOnceGone]).toEqual([true, 0, 1_000]);
  });

  it('As a chain pool, I hold back a lease that failed to take a chain on its gate while the chain is up', () => {
    // Given a chain that halted and was redialed, and the rebuilt chain is up
    const { redial, setStatus } = setup();
    redial.noteHalt('0xaa', 'chain');
    redial.tryDial('0xaa', 'chain');
    setStatus('connecting');

    // When a lease whose take of it failed asks
    const retried = redial.tryDialGate('0xaa', 'chain');
    const wait = redial.gateWaitMs('0xaa', 'chain');
    const joinWait = redial.waitMs('0xaa', 'chain');

    // Then it waits the gate's 1 s, where a lease that has not tried joins at once
    expect([retried, wait, joinWait]).toEqual([false, 1_000, 0]);
  });

  it('As a chain pool, I hold back a frame halt on the frame gate while the frame is down', () => {
    // Given the frame halted and is down
    const { redial } = setup({ frameDown: true });
    redial.noteHalt('0xaa', 'frame');

    // When
    const first = redial.tryDial('0xaa', 'frame');
    const second = redial.tryDial('0xaa', 'frame');

    // Then
    expect([first, second]).toEqual([true, false]);
  });

  it("As a chain pool, I hold back a frame halt on the chain's gate while the frame is up", () => {
    // Given the frame halted and is up again
    const { redial, setStatus } = setup();
    redial.noteHalt('0xaa', 'frame');

    // When it is redialed, halts again, and another lease rebuilds the chain
    const first = redial.tryDial('0xaa', 'frame');
    redial.noteHalt('0xaa', 'frame');
    const second = redial.tryDial('0xaa', 'frame');
    const wait = redial.waitMs('0xaa', 'frame');
    setStatus('connected');
    const joined = redial.tryDial('0xaa', 'frame');

    // Then
    expect([first, second, wait, joined]).toEqual([true, false, 1_000, true]);
  });

  it("As a chain pool, I keep one chain's backoff from holding another", () => {
    // Given 0xaa's gate is shut
    const { redial } = setup();
    redial.noteHalt('0xaa', 'chain');
    redial.tryDial('0xaa', 'chain');
    redial.noteHalt('0xaa', 'chain');
    redial.noteHalt('0xbb', 'chain');

    // When
    const other = redial.tryDial('0xbb', 'chain');

    // Then
    expect(other).toBe(true);
  });
});

function setup({ frameDown = false }: Params = {}) {
  let status: ConnectionStatus = 'disconnected';
  const redial = createChainRedial({
    status: () => status,
    isFrameDown: () => frameDown,
    timers: createManualTimers(),
  });
  return { redial, setStatus };

  function setStatus(next: ConnectionStatus): void {
    status = next;
  }
}
