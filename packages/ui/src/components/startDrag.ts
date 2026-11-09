// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bodySelection, type SelectionLock } from './createSelectionLock.js';

/** What a drag needs of its handle. */
export type DragTarget = Pick<HTMLElement, 'setPointerCapture' | 'addEventListener' | 'removeEventListener'>;

/** What a drag calls back. `end` runs once, and `released` is true only for a pointerup, the one end to commit. */
export type DragHandlers = {
  move: (event: PointerEvent) => void;
  end?: (released: boolean) => void;
};

/** What `startDrag` follows, and the lock that holds the selection off meanwhile. */
export type StartDragParams = {
  /** The handle the pointer went down on. */
  target: DragTarget;
  /** The pointerdown that starts the drag. */
  down: Pick<PointerEvent, 'pointerId'>;
  /** What the drag calls back with each move and once at its end. */
  handlers: DragHandlers;
  /** The page's own lock by default. */
  selection?: SelectionLock | undefined;
};

/**
 * Follow one captured pointer drag until pointerup or pointercancel, which no pointerup follows.
 * The returned function cancels it early, and a component keeps it for its cleanup. Throws only what `selection` or a
 * handler throws.
 */
export function startDrag({ target, down, handlers, selection = bodySelection }: StartDragParams): () => void {
  try {
    target.setPointerCapture(down.pointerId);
    // eslint-disable-next-line no-restricted-syntax -- a pointer that is no longer active (a synthetic event in tests) cannot be captured, and the drag still follows moves over the target.
  } catch {
    /* not capturable */
  }
  const release = selection.hold();
  let done = false;

  // A move or an end of another pointer is not this drag's.
  function handleMove(event: PointerEvent): void {
    if (event.pointerId === down.pointerId) {
      handlers.move(event);
    }
  }

  function handleEnd(event: PointerEvent): void {
    if (event.pointerId === down.pointerId) {
      end(event.type === 'pointerup');
    }
  }

  function end(released: boolean): void {
    if (done) {
      return;
    }
    done = true;
    target.removeEventListener('pointermove', handleMove);
    target.removeEventListener('pointerup', handleEnd);
    target.removeEventListener('pointercancel', handleEnd);
    release();
    handlers.end?.(released);
  }

  target.addEventListener('pointermove', handleMove);
  target.addEventListener('pointerup', handleEnd);
  target.addEventListener('pointercancel', handleEnd);
  return () => {
    end(false);
  };
}
