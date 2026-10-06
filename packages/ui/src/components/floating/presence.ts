// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js';

/**
 * Which opening a surface's content belongs to: a new number at each
 * opening, kept after a close until the exit (`exitMs`) has played, then 0.
 * Content keyed on it mounts afresh at each opening, a reopening during the
 * exit included, and is in the page in the same flush as the opening, so
 * focus can move into it at once.
 */
export function createPresence(open: Accessor<boolean>, exitMs: number): Accessor<number> {
  const opening = createMemo<{ count: number; open: boolean }>(prev => {
    const now = open();
    const count = prev?.count ?? 0;
    return { count: now && prev?.open !== true ? count + 1 : count, open: now };
  });
  const [lingering, setLingering] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wasOpen = false;
  createEffect(open, now => {
    clearTimeout(timer);
    if (now) {
      wasOpen = true;
      setLingering(true);
      return;
    }
    // Nothing is exiting before the first opening: no timer for a surface
    // that mounts closed.
    if (!wasOpen) {
      return;
    }
    wasOpen = false;
    timer = setTimeout(() => {
      setLingering(false);
    }, exitMs);
  });
  onCleanup(() => {
    clearTimeout(timer);
  });
  return () => (open() || lingering() ? opening().count : 0);
}
