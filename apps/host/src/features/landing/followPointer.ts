// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** Takes where the pointer is in the viewport on each axis, from -1 at its left or top edge to 1 at its right or foot. */
  onShift: (shift: { x: number; y: number }) => void;
  view?: Pick<Window, 'innerWidth' | 'innerHeight' | 'addEventListener' | 'removeEventListener'>;
  frames?: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>;
};

/**
 * Reports where the pointer is in the viewport as it moves, at most once a frame and with its latest place, until the
 * returned stop. A hidden page gets neither pointer moves nor frames, so it does no work.
 */
export function followPointer({ onShift, view = window, frames = window }: Params): () => void {
  let clientX = 0;
  let clientY = 0;
  let frame: number | null = null;
  function handleMove(event: PointerEvent) {
    clientX = event.clientX;
    clientY = event.clientY;
    frame ??= frames.requestAnimationFrame(() => {
      frame = null;
      onShift({ x: getPointerShift(clientX, view.innerWidth), y: getPointerShift(clientY, view.innerHeight) });
    });
  }
  view.addEventListener('pointermove', handleMove, { passive: true });
  return () => {
    view.removeEventListener('pointermove', handleMove);
    if (frame !== null) {
      frames.cancelAnimationFrame(frame);
    }
  };
}

/** Where a pointer at `client` is along a viewport axis `length` long, from -1 at its start to 1 at its end, held there past them. */
export function getPointerShift(client: number, length: number): number {
  return Math.min(Math.max((2 * client) / length - 1, -1), 1);
}
