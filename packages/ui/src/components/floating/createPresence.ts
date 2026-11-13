// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from '@dotli/shared';
import { createEffect, createMemo, createSignal, type Accessor } from 'solid-js';

type Params = {
  /** Whether the content is open. */
  open: Accessor<boolean>;
  /** How long the exit plays after a close. */
  exitMs: number;
  /** The page's own by default. The exit timer runs on them. */
  timers?: Timers | undefined;
};

/**
 * A new number at each opening, kept through the exit (`exitMs` on `timers`), then 0.
 * Content keyed on it remounts per opening and mounts in the opening's flush, so focus can move in at once. Called
 * inside a component, which clears the exit timer when it is disposed.
 */
export function createPresence({ open, exitMs, timers = realTimers }: Params): Accessor<number> {
  const opening = createMemo<{ count: number; open: boolean }>(previous => {
    const now = open();
    const count = previous?.count ?? 0;
    return { count: now && previous?.open !== true ? count + 1 : count, open: now };
  });
  const [lingering, setLingering] = createSignal(false);
  createEffect(open, (now, wasOpen = false) => {
    if (now) {
      setLingering(true);
      return;
    }
    if (!wasOpen) {
      return;
    }
    const timer = timers.setTimeout(() => {
      setLingering(false);
    }, exitMs);
    // A reopening, or the component's disposal, cancels the exit.
    return () => {
      timers.clearTimeout(timer);
    };
  });
  return () => (open() || lingering() ? opening().count : 0);
}
