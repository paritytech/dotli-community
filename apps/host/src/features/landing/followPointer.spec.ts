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
  it('As a visitor who moves the pointer twice, I turn the orbit on both axes once for each move', () => {
    // Given
    const { view, shifts, move } = setup();
    followPointer({ onShift: shift => shifts.push(shift), view });

    // When
    move(250, 200);
    move(750, 600);

    // Then
    expect(shifts).toEqual([
      { x: -0.5, y: -0.5 },
      { x: 0.5, y: 0.5 },
    ]);
  });

  it('As a visitor who left the landing page, I move the pointer and move no orbit', () => {
    // Given
    const { view, shifts, move } = setup();
    const stop = followPointer({ onShift: shift => shifts.push(shift), view });
    stop();

    // When
    move(1000, 800);

    // Then
    expect(shifts).toEqual([]);
  });
});

/** A window that fires pointer moves on demand. */
function setup() {
  const view = Object.assign(new EventTarget(), { innerWidth: WIDTH, innerHeight: HEIGHT });
  function move(clientX: number, clientY: number) {
    view.dispatchEvent(Object.assign(new Event('pointermove'), { clientX, clientY }));
  }
  return { view, shifts: [] as { x: number; y: number }[], move };
}
