// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { followPointer, getPointerShift } from './followPointer.js';

/** The viewport's size in the fake window. */
const WIDTH = 1000;
const HEIGHT = 800;

describe('getPointerShift', () => {
  it.each([
    { client: 400, shift: 0 },
    { client: 0, shift: -1 },
    { client: 800, shift: 1 },
    { client: 200, shift: -0.5 },
    { client: -120, shift: -1 },
    { client: 950, shift: 1 },
  ])(
    'As a visitor with the pointer at $client down a viewport 800 tall, I move the orbit by $shift',
    ({ client, shift }) => {
      // When
      const actual = getPointerShift(client, HEIGHT);

      // Then
      expect(actual).toBe(shift);
    },
  );
});

describe('followPointer', () => {
  it('As a visitor who moves the pointer several times in one frame, I turn the orbit once to where it ended on both axes', () => {
    // Given
    const { view, frames, shifts, move, runFrame } = setup();
    followPointer({ onShift: shift => shifts.push(shift), view, frames });
    move(0, 0);
    move(250, 200);
    move(750, 600);

    // When
    runFrame();

    // Then
    expect(shifts).toEqual([{ x: 0.5, y: 0.5 }]);
  });

  it('As a visitor who leaves the landing page mid-frame, I leave no frame behind', () => {
    // Given
    const { view, frames, shifts, move, runFrame } = setup();
    const stop = followPointer({ onShift: shift => shifts.push(shift), view, frames });
    move(0, 0);

    // When
    stop();
    move(1000, 800);
    runFrame();

    // Then
    expect(shifts).toEqual([]);
  });

  it('As a visitor who left the landing page, I move the pointer and move no orbit', () => {
    // Given
    const { view, frames, shifts, move, runFrame } = setup();
    const stop = followPointer({ onShift: shift => shifts.push(shift), view, frames });
    stop();

    // When
    move(1000, 800);
    runFrame();

    // Then
    expect(shifts).toEqual([]);
  });
});

/** A window that fires pointer moves on demand, and a frame scheduler that runs its frame when told. */
function setup() {
  const view = Object.assign(new EventTarget(), { innerWidth: WIDTH, innerHeight: HEIGHT });
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
  function move(clientX: number, clientY: number) {
    view.dispatchEvent(Object.assign(new Event('pointermove'), { clientX, clientY }));
  }
  function runFrame() {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) {
      callback(0);
    }
  }
  return { view, frames, shifts: [] as { x: number; y: number }[], move, runFrame };
}
