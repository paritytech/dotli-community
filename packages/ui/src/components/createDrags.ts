// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter } from '@dotli/metrics';
import { bodySelection, type SelectionLock } from './createSelectionLock.js';
import { startDrag, type StartDragParams } from './startDrag.js';

const report = createReporter({ flow: 'ui' });

/** The drag one component runs. Its cleanup calls `stopAll`, so no hold outlives it. */
export type Drags = ReturnType<typeof createDrags>;

type Params = {
  /** The page's own lock by default. */
  selection?: SelectionLock | undefined;
};

type State = { kind: 'idle' } | { kind: 'held'; pointerId: number; stop: () => void };

const reportDragEnd = report.listener('drag.end');

/**
 * One owner for a component's drag. It holds at most one drag, so a second pointer, such as a second finger, is
 * refused while one is held. A handle that leaves the page under a held pointer loses its capture, so its pointerup
 * never comes, and only its owner can end that drag, or the same pointer's next press, since a pointer cannot be down
 * twice.
 *
 * @example
 * const drags = createDrags(); // onCleanup(drags.stopAll)
 * drags.start({ target: handle, down: event, handlers: { move: onMove, end: onEnd } });
 */
export function createDrags({ selection = bodySelection }: Params = {}) {
  let state: State = { kind: 'idle' };

  function start({ target, down, handlers }: Omit<StartDragParams, 'selection'>): boolean {
    if (state.kind === 'held') {
      if (state.pointerId !== down.pointerId) {
        return false;
      }
      stopAll();
    }
    const stop = startDrag({
      target,
      down,
      handlers: {
        move: handlers.move,
        end(released) {
          if (state.kind === 'held' && state.stop === stop) {
            state = { kind: 'idle' };
          }
          handlers.end?.(released);
        },
      },
      selection,
    });
    state = { kind: 'held', pointerId: down.pointerId, stop };
    return true;
  }

  function stopAll(): void {
    const previous = state;
    state = { kind: 'idle' };
    // A throwing `end` has already given its hold back.
    try {
      if (previous.kind === 'held') {
        previous.stop();
      }
    } catch (error: unknown) {
      reportDragEnd(error);
    }
  }

  return {
    /**
     * Starts a drag that ends on its own pointer's release, or is cancelled by `stopAll`. Returns `true` when it took
     * the pointer, and `false`, doing nothing, while a drag is held by another pointer. A press of the held drag's own
     * pointer ends the held drag as cancelled, since it missed its end, and takes the pointer. Throws only what the
     * selection lock's `apply` throws.
     */
    start,
    /** Cancels the held drag. Safe to call twice, and never throws: a throwing `end` is reported. */
    stopAll,
  };
}
