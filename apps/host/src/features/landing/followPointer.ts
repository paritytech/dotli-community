// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** Takes where the pointer is in the viewport on each axis, from -1 at its left or top edge to 1 at its right or foot. */
  onShift: (shift: { x: number; y: number }) => void;
  view?: Pick<Window, 'innerWidth' | 'innerHeight' | 'addEventListener' | 'removeEventListener'>;
};

/**
 * Reports where the pointer is in the viewport on each move, until the returned stop. A hidden page gets no pointer
 * moves, so it does no work.
 */
export function followPointer({ onShift, view = window }: Params): () => void {
  function handleMove(event: PointerEvent) {
    onShift({
      x: getPointerShift(event.clientX, view.innerWidth),
      y: getPointerShift(event.clientY, view.innerHeight),
    });
  }
  view.addEventListener('pointermove', handleMove, { passive: true });
  return () => {
    view.removeEventListener('pointermove', handleMove);
  };
}

/** Where a pointer at `client` is along a viewport axis `length` long, from -1 at its start to 1 at its end, held there past them. */
export function getPointerShift(client: number, length: number): number {
  return Math.min(Math.max((2 * client) / length - 1, -1), 1);
}
