// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter } from '@dotli/metrics';
import { bodySelection, type SelectionLock } from './createSelectionLock.js';
import { startDrag, type StartDragParams } from './startDrag.js';

const report = createReporter({ flow: 'ui' });

/** The drags one component runs. Its cleanup calls `stopAll`, so no hold outlives it. */
export type Drags = ReturnType<typeof createDrags>;

type Params = {
  /** The page's own lock by default. */
  selection?: SelectionLock | undefined;
};

const reportDragEnd = report.listener('drag.end');

/**
 * One owner for a component's drags. A handle that leaves the page under a held pointer loses its capture, so its
 * pointerup never comes, and only its owner can end that drag.
 *
 * @example
 * const drags = createDrags(); // onCleanup(drags.stopAll)
 * drags.start({ target: handle, down: event, handlers: { move: onMove, end: onEnd } });
 */
export function createDrags({ selection = bodySelection }: Params = {}) {
  const live = new Set<() => void>();

  function start({ target, down, handlers }: Omit<StartDragParams, 'selection'>): void {
    const stop = startDrag({
      target,
      down,
      handlers: {
        move: handlers.move,
        end(released) {
          live.delete(stop);
          handlers.end?.(released);
        },
      },
      selection,
    });
    live.add(stop);
  }

  function stopAll(): void {
    for (const stop of [...live]) {
      // A throwing `end` has already given its hold back, and must not keep the later drags holding theirs.
      try {
        stop();
      } catch (error: unknown) {
        reportDragEnd(error);
      }
    }
  }

  return {
    /**
     * Starts a drag that ends on its own pointer's release, or is cancelled by `stopAll`. Throws only what the
     * selection lock's `apply` throws.
     */
    start,
    /** Cancels every drag still going. Safe to call twice, and never throws: a throwing `end` is reported. */
    stopAll,
  };
}
