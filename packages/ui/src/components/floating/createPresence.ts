// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from '@dotli/shared';
import { createEffect, createMemo, createSignal, type Accessor } from 'solid-js';

/** The element an exit transition plays on. A page's element is one. */
type ExitTarget = EventTarget & {
  getAnimations: () => readonly unknown[];
};

type Params = {
  /** Whether the content is open. */
  open: Accessor<boolean>;
  /**
   * How the exit after a close ends: after `ms` on `timers`, the page's own by default, or when the transition
   * `target` runs at the close ends, at once when it runs none.
   */
  exit:
    | { kind: 'timer'; ms: number; timers?: Timers | undefined }
    | { kind: 'transition'; target: () => ExitTarget | null };
};

/**
 * A new number at each opening, kept through the exit, then 0.
 * Content keyed on it remounts per opening and mounts in the opening's flush, so focus can move in at once. Called
 * inside a component, which clears the exit's timer or listeners when it is disposed.
 */
export function createPresence({ open, exit }: Params): Accessor<number> {
  const opening = createMemo<{ count: number; open: boolean }>(previous => {
    const now = open();
    const count = previous?.count ?? 0;
    return { count: now && previous?.open !== true ? count + 1 : count, open: now };
  });
  const [lingering, setLingering] = createSignal(false);

  function end(): void {
    setLingering(false);
  }

  function endAfterTimer(ms: number, timers: Timers): () => void {
    const timer = timers.setTimeout(end, ms);
    return () => {
      timers.clearTimeout(timer);
    };
  }

  function endOnTransition(target: ExitTarget | null): (() => void) | undefined {
    // The close started no transition, such as under reduced motion, so no end event would come.
    if (target === null || target.getAnimations().length === 0) {
      end();
      return undefined;
    }
    const handleEnd = (event: Event): void => {
      // Transitions inside the target bubble up to it.
      if (event.target === target) {
        end();
      }
    };
    target.addEventListener('transitionend', handleEnd);
    target.addEventListener('transitioncancel', handleEnd);
    return () => {
      target.removeEventListener('transitionend', handleEnd);
      target.removeEventListener('transitioncancel', handleEnd);
    };
  }

  createEffect(open, (now, wasOpen = false) => {
    if (now) {
      setLingering(true);
      return;
    }
    if (!wasOpen) {
      return;
    }
    // A reopening, or the component's disposal, cancels the exit.
    return exit.kind === 'timer' ? endAfterTimer(exit.ms, exit.timers ?? realTimers) : endOnTransition(exit.target());
  });
  return () => (open() || lingering() ? opening().count : 0);
}
