// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The stop nearest to `fraction` of the track, 0 at its start and 1 at its end. */
export function stopAt(fraction: number, count: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * (count - 1));
}

// Enter and Space commit the stop the slider is on, the one way to apply it again from the keyboard.
const KEYS: Readonly<Record<string, (index: number, count: number) => number>> = {
  ArrowRight: index => index + 1,
  ArrowUp: index => index + 1,
  ArrowLeft: index => index - 1,
  ArrowDown: index => index - 1,
  Home: () => 0,
  End: (_index, count) => count - 1,
  Enter: index => index,
  ' ': index => index,
};

/** The stop a key commits, held at the ends, or null for a key the slider leaves alone. */
export function stopForKey(key: string, index: number, count: number): number | null {
  const move = KEYS[key];
  return move === undefined ? null : Math.min(count - 1, Math.max(0, move(index, count)));
}
