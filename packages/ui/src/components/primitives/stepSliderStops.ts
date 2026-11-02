// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** The key pressed, as `KeyboardEvent.key` names it. */
  key: string;
  /** The stop the slider is on. */
  index: number;
  /** How many stops the track has. */
  count: number;
};

const STEPS: Readonly<Record<string, (index: number, count: number) => number>> = {
  ArrowRight: index => index + 1,
  ArrowUp: index => index + 1,
  ArrowLeft: index => index - 1,
  ArrowDown: index => index - 1,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

// Enter and Space commit the stop the slider is on, the one way to apply it again from the keyboard.
const COMMITS: ReadonlySet<string> = new Set(['Enter', ' ']);

/** The stop nearest to `fraction` of the track, 0 at its start and 1 at its end. Never throws. */
export function getStopAt(fraction: number, count: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * (count - 1));
}

/** True for a key the slider acts on, even where it commits nothing, so the page does not scroll for it. Never throws. */
export function isHandledKey(key: string): boolean {
  return key in STEPS || COMMITS.has(key);
}

/**
 * The stop a key commits, or null. A step key commits only a step, so at an end it commits nothing. Enter and Space
 * commit the stop the slider is on. Never throws.
 */
export function getStopForKey({ key, index, count }: Params): number | null {
  if (COMMITS.has(key)) {
    return index;
  }
  const step = STEPS[key];
  if (step === undefined) {
    return null;
  }
  const next = Math.min(count - 1, Math.max(0, step(index, count)));
  return next === index ? null : next;
}
