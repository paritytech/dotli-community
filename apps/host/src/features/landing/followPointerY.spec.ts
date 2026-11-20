// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { followPointerY, getPointerShift } from './followPointerY.js';

/** The viewport's height in the fake window. */
const HEIGHT = 800;

describe('getPointerShift', () => {
  it.each([
    { clientY: 400, shift: 0 },
    { clientY: 0, shift: -1 },
    { clientY: 800, shift: 1 },
    { clientY: 200, shift: -0.5 },
    { clientY: -120, shift: -1 },
    { clientY: 950, shift: 1 },
  ])('As a visitor with the pointer at $clientY of 800, I tilt the orbit by $shift', ({ clientY, shift }) => {
    // When
    const actual = getPointerShift(clientY, HEIGHT);

    // Then
    expect(actual).toBe(shift);
  });
});

describe('followPointerY', () => {
  it('As a visitor who moves the pointer several times in one frame, I tilt the orbit once to where it ended', () => {
    // Given
    const { view, frames, shifts, move, runFrame } = setup();
    followPointerY({ onShift: shift => shifts.push(shift), view, frames });
    move(0);
    move(200);
    move(600);

    // When
    runFrame();

    // Then
    expect(shifts).toEqual([0.5]);
  });

  it('As a visitor who leaves the landing page mid-frame, I leave no frame behind', () => {
    // Given
    const { view, frames, shifts, move, runFrame } = setup();
    const stop = followPointerY({ onShift: shift => shifts.push(shift), view, frames });
    move(0);

    // When
    stop();
    move(800);
    runFrame();

    // Then
    expect(shifts).toEqual([]);
  });

  it('As a visitor who left the landing page, I move the pointer and tilt no orbit', () => {
    // Given
    const { view, frames, shifts, move, runFrame } = setup();
    const stop = followPointerY({ onShift: shift => shifts.push(shift), view, frames });
    stop();

    // When
    move(800);
    runFrame();

    // Then
    expect(shifts).toEqual([]);
  });
});

/** A window that fires pointer moves on demand, and a frame scheduler that runs its frame when told. */
function setup() {
  const view = Object.assign(new EventTarget(), { innerHeight: HEIGHT });
  const pending = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const frames = {
    requestAnimationFrame(callback: FrameRequestCallback) {
      pending.set(nextFrame, callback);
      return nextFrame++;
    },
    cancelAnimationFrame(handle: number) {
      pending.delete(handle);
    },
  };
  function move(clientY: number) {
    view.dispatchEvent(Object.assign(new Event('pointermove'), { clientY }));
  }
  function runFrame() {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) {
      callback(0);
    }
  }
  return { view, frames, shifts: [] as number[], move, runFrame };
}
