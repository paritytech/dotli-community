// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

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

/**
 * Follow one captured pointer drag until pointerup or pointercancel, which no pointerup follows.
 * `end` runs once however the drag ends. The returned function ends it early, for an unmount mid-drag.
 */
export function startDrag(
  target: DragTarget,
  down: Pick<PointerEvent, 'pointerId'>,
  handlers: { move: (event: PointerEvent) => void; end?: () => void },
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
      end();
    }
  };
  const end = (): void => {
    if (done) {
      return;
    }
    done = true;
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onEnd);
    target.removeEventListener('pointercancel', onEnd);
    release();
    handlers.end?.();
  };
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onEnd);
  target.addEventListener('pointercancel', onEnd);
  return end;
}
