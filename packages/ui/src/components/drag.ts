// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Follow one pointer drag that began with `down` on `target`. The pointer is
 * captured, so its moves and its release reach `target` wherever it goes, and
 * the drag ends on pointerup or on pointercancel, which is never followed by
 * a pointerup. Text selection is off while it lasts. `end` runs once,
 * however the drag ends. Returns a function that ends it early, for a
 * component unmounting mid-drag.
 */
export function startDrag(
  target: HTMLElement,
  down: PointerEvent,
  handlers: { move: (event: PointerEvent) => void; end?: () => void },
): () => void {
  try {
    target.setPointerCapture(down.pointerId);
    // eslint-disable-next-line no-restricted-syntax -- a pointer that is no longer active (a synthetic event in tests) cannot be captured; the drag still follows moves over the target.
  } catch {
    /* not capturable */
  }
  document.body.style.userSelect = "none";
  let done = false;
  const end = (): void => {
    if (done) {
      return;
    }
    done = true;
    target.removeEventListener("pointermove", handlers.move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
    document.body.style.userSelect = "";
    handlers.end?.();
  };
  target.addEventListener("pointermove", handlers.move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
  return end;
}
