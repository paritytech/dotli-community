// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** Takes where the pointer is up the viewport, from -1 at its top to 1 at its foot. */
  onShift: (shift: number) => void;
  view?: Pick<Window, 'innerHeight' | 'addEventListener' | 'removeEventListener'>;
  frames?: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>;
};

/**
 * Reports where the pointer is up the viewport as it moves, at most once a frame and with its latest place, until the
 * returned stop. A hidden page gets neither pointer moves nor frames, so it does no work.
 */
export function followPointerY({ onShift, view = window, frames = window }: Params): () => void {
  let clientY = 0;
  let frame: number | null = null;
  function handleMove(event: PointerEvent) {
    clientY = event.clientY;
    frame ??= frames.requestAnimationFrame(() => {
      frame = null;
      onShift(getPointerShift(clientY, view.innerHeight));
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

/** Where a pointer at `clientY` is up a viewport `height` tall, from -1 at its top to 1 at its foot, held there past them. */
export function getPointerShift(clientY: number, height: number): number {
  return Math.min(Math.max((2 * clientY) / height - 1, -1), 1);
}
