// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { OrbitShift } from './pickOrbitFollower.js';

/** How far, in degrees, the phone tilts from where it was first held to shift the orbit all the way. */
const FULL_TILT = 20;

type Params = {
  /**
   * Takes how far the phone is tilted from where it was first held, on each of the screen's axes, from -1 to 1. Tipping
   * the screen's right edge away gives a positive x, as a pointer moving right does, and tipping its top edge away a
   * negative y, as a pointer moving up does.
   */
  onShift: (shift: OrbitShift) => void;
  view?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** The screen's rotation from the device's natural orientation in degrees, 90 with the device turned a quarter left. */
  getScreenAngle?: () => number;
};

/**
 * Reports how far the phone is tilted from where it was held at its first usable reading on each orientation event,
 * until the returned stop. That first reading stays the zero while it runs. A reading with no values, as a browser with
 * no sensor sends, is skipped. A hidden page gets no orientation events, so it does no work.
 */
export function followOrientation({
  onShift,
  view = window,
  getScreenAngle = () => screen.orientation.angle,
}: Params): () => void {
  let zero: { beta: number; gamma: number } | null = null;

  function handleOrientation({ beta, gamma }: DeviceOrientationEvent) {
    if (beta === null || gamma === null) {
      return;
    }
    zero ??= { beta, gamma };
    // On the device's own axes: gamma grows as its right edge dips, and beta as its top edge comes up, which the
    // pointer matches by moving down.
    const right = gamma - zero.gamma;
    const down = beta - zero.beta;
    // A screen turned with the device a quarter left has the device's foot at its right and its right edge at its top.
    const angle = (getScreenAngle() * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    onShift({
      x: getTiltShift(right * cos + down * sin),
      y: getTiltShift(down * cos - right * sin),
    });
  }
  view.addEventListener('deviceorientation', handleOrientation);
  return () => {
    view.removeEventListener('deviceorientation', handleOrientation);
  };
}

function getTiltShift(tilt: number): number {
  return Math.min(Math.max(tilt / FULL_TILT, -1), 1);
}
