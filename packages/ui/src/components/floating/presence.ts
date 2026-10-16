// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js';

/**
 * A new number at each opening, kept through the exit (`exitMs`), then 0.
 * Content keyed on it remounts per opening and mounts in the opening's flush, so focus can move in at once.
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
