// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { reportListener } from '@dotli/metrics';

/** What a drag needs of its handle. */
export type DragTarget = Pick<HTMLElement, 'setPointerCapture' | 'addEventListener' | 'removeEventListener'>;

/** Holds the page's text selection off while anything holds it. */
export interface SelectionLock {
  /** Locks until the returned release, which is safe to call twice. */
  hold: () => () => void;
}

/** A lock over `apply`, locked by the first hold and unlocked by the last release. */
export function createSelectionLock(apply: (locked: boolean) => void): SelectionLock {
  let holders = 0;
  return {
    hold: () => {
      holders += 1;
      if (holders === 1) {
        apply(true);
      }
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        holders -= 1;
        if (holders === 0) {
          apply(false);
        }
      };
    },
  };
}

// One lock for the page, so two drags at once keep selection off until both end.
const bodySelection = createSelectionLock(locked => {
  document.body.style.userSelect = locked ? 'none' : '';
});

/** What a drag calls back. `end` runs once, and `released` is true only for a pointerup, the one end to commit. */
export interface DragHandlers {
  move: (event: PointerEvent) => void;
  end?: (released: boolean) => void;
}

/**
 * Follow one captured pointer drag until pointerup or pointercancel, which no pointerup follows.
 * The returned function cancels it early. Components start drags through `createDrags`, which keeps that cancel for
 * their cleanup.
 */
export function startDrag(
  target: DragTarget,
  down: Pick<PointerEvent, 'pointerId'>,
  handlers: DragHandlers,
  selection: SelectionLock = bodySelection,
): () => void {
  try {
    target.setPointerCapture(down.pointerId);
    // eslint-disable-next-line no-restricted-syntax -- a pointer that is no longer active (a synthetic event in tests) cannot be captured; the drag still follows moves over the target.
  } catch {
    /* not capturable */
  }
  const release = selection.hold();
  let done = false;
  // Another pointer on the same handle, such as a second finger, runs its own drag.
  const onMove = (event: PointerEvent): void => {
    if (event.pointerId === down.pointerId) {
      handlers.move(event);
    }
  };
  const onEnd = (event: PointerEvent): void => {
    if (event.pointerId === down.pointerId) {
      end(event.type === 'pointerup');
    }
  };
  const end = (released: boolean): void => {
    if (done) {
      return;
    }
    done = true;
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onEnd);
    target.removeEventListener('pointercancel', onEnd);
    release();
    handlers.end?.(released);
  };
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onEnd);
  target.addEventListener('pointercancel', onEnd);
  return () => {
    end(false);
  };
}

/** The drags one component runs. Its cleanup calls `stopAll`, so no hold outlives it. */
export interface Drags {
  /** Starts a drag that ends on its own pointer's release, or is cancelled by `stopAll`. */
  start: (target: DragTarget, down: Pick<PointerEvent, 'pointerId'>, handlers: DragHandlers) => void;
  /** Cancels every drag still going. Safe to call twice. */
  stopAll: () => void;
}

const reportDragEnd = reportListener('ui', 'drag.end');

/**
 * One owner for a component's drags. A handle that leaves the page under a held pointer loses its capture, so its
 * pointerup never comes, and only its owner can end that drag.
 */
export function createDrags(selection: SelectionLock = bodySelection): Drags {
  const live = new Set<() => void>();
  return {
    start: (target, down, handlers) => {
      const stop = startDrag(
        target,
        down,
        {
          move: handlers.move,
          end: released => {
            live.delete(stop);
            handlers.end?.(released);
          },
        },
        selection,
      );
      live.add(stop);
    },
    stopAll: () => {
      for (const stop of [...live]) {
        // A throwing `end` has already given its hold back, and must not keep the later drags holding theirs.
        try {
          stop();
        } catch (err: unknown) {
          reportDragEnd(err);
        }
      }
    },
  };
}
