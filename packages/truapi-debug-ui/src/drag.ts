// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** What a drag needs of its handle. */
export type DragTarget = Pick<HTMLElement, 'setPointerCapture' | 'addEventListener' | 'removeEventListener'>;

/** Stops the page selecting text while a drag runs. */
function lockBodySelection(locked: boolean): void {
  document.body.style.userSelect = locked ? 'none' : '';
}

/**
 * Follow one captured pointer drag until pointerup or pointercancel, which no pointerup follows.
 * `end` runs once however the drag ends. The returned function ends it early, for an unmount mid-drag.
 */
export function startDrag(
  target: DragTarget,
  down: Pick<PointerEvent, 'pointerId'>,
  handlers: { move: (event: PointerEvent) => void; end?: () => void },
  lockSelection: (locked: boolean) => void = lockBodySelection,
): () => void {
  try {
    target.setPointerCapture(down.pointerId);
    // eslint-disable-next-line no-restricted-syntax -- a pointer that is no longer active (a synthetic event in tests) cannot be captured; the drag still follows moves over the target.
  } catch {
    /* not capturable */
  }
  lockSelection(true);
  let done = false;
  const end = (): void => {
    if (done) {
      return;
    }
    done = true;
    target.removeEventListener('pointermove', handlers.move);
    target.removeEventListener('pointerup', end);
    target.removeEventListener('pointercancel', end);
    lockSelection(false);
    handlers.end?.();
  };
  target.addEventListener('pointermove', handlers.move);
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
  return end;
}
