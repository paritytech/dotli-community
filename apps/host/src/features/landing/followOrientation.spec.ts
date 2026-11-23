// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { followOrientation } from './followOrientation.js';
import type { OrbitShift } from './pickOrbitFollower.js';

/** Where the phone is first held in the fake window. */
const HELD = { beta: 40, gamma: 5 };

describe('followOrientation', () => {
  it.each([
    { angle: 0, beta: -10, gamma: 10 },
    { angle: 90, beta: 10, gamma: 10 },
    { angle: 180, beta: 10, gamma: -10 },
    { angle: 270, beta: -10, gamma: -10 },
  ])(
    'As a visitor holding the phone turned $angle degrees, I tip its right and top edges away and turn the orbit as a pointer moving right and up does',
    ({ angle, beta, gamma }) => {
      // Given
      const { view, shifts, tilt } = setup();
      followOrientation({ onShift: shift => shifts.push(shift), view, getScreenAngle: () => angle });
      tilt(HELD.beta, HELD.gamma);

      // When
      tilt(HELD.beta + beta, HELD.gamma + gamma);

      // Then, close to the shift, since turning the axes by the screen's angle leaves float noise
      expect(shifts.at(-1)?.x).toBeCloseTo(0.5);
      expect(shifts.at(-1)?.y).toBeCloseTo(-0.5);
    },
  );

  it('As a visitor who tips the phone far past where it was held, I turn the orbit to its edge and no further', () => {
    // Given
    const { view, shifts, tilt } = setup();
    followOrientation({ onShift: shift => shifts.push(shift), view, getScreenAngle: () => 0 });
    tilt(HELD.beta, HELD.gamma);

    // When
    tilt(HELD.beta + 35, HELD.gamma - 60);

    // Then
    expect(shifts.at(-1)).toEqual({ x: -1, y: 1 });
  });

  it('As a visitor whose browser first sends a reading with no values, I hold the phone and measure from the first real reading', () => {
    // Given
    const { view, shifts, tilt } = setup();
    followOrientation({ onShift: shift => shifts.push(shift), view, getScreenAngle: () => 0 });

    // When
    tilt(null, null);
    tilt(HELD.beta, HELD.gamma);
    tilt(HELD.beta + 10, HELD.gamma);

    // Then
    expect(shifts).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0.5 },
    ]);
  });

  it('As a visitor who left the landing page, I tilt the phone and move no orbit', () => {
    // Given
    const { view, shifts, tilt } = setup();
    const stop = followOrientation({ onShift: shift => shifts.push(shift), view, getScreenAngle: () => 0 });
    stop();

    // When
    tilt(HELD.beta, HELD.gamma);

    // Then
    expect(shifts).toEqual([]);
  });
});

/** A window that fires orientation readings on demand. */
function setup() {
  const view = new EventTarget();
  function tilt(beta: number | null, gamma: number | null) {
    view.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta, gamma }));
  }
  return { view, shifts: [] as OrbitShift[], tilt };
}
