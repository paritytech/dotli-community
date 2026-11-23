// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { followOrientation } from './followOrientation.js';
import { followPointer } from './followPointer.js';

/** How far the input has moved the orbit on each axis, from -1 to 1. */
export type OrbitShift = { x: number; y: number };

/** Starts reporting shifts to `onShift` and returns the cleanup that ends it. */
export type OrbitFollower = (params: { onShift: (shift: OrbitShift) => void }) => () => void;

/**
 * Picks the input that turns and tilts the orbit on this device: none where the visitor asks for less motion, the
 * pointer where it hovers finely, and the phone's tilt everywhere else.
 */
export function pickOrbitFollower(
  matchMedia: (query: string) => Pick<MediaQueryList, 'matches'> = query => window.matchMedia(query),
): OrbitFollower | null {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return null;
  }
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    return followPointer;
  }
  return followOrientation;
}
