// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DragTarget, Drags } from '../drag.js';

/** A swipe past this share of the sheet's height closes it. */
const SWIPE_CLOSE_FRACTION = 0.3;
/** So does one faster than this, in px/ms... */
const SWIPE_CLOSE_SPEED = 0.5;
/** ...that went at least this far, so a tap's jitter is no flick. */
const SWIPE_FLICK_MIN_PX = 24;

/** What the drag moves, so a spec can stand in for the sheet's element. */
export type SheetSurface = Pick<HTMLElement, 'setAttribute' | 'removeAttribute' | 'offsetHeight'> & {
  style: Pick<CSSStyleDeclaration, 'transform'>;
};

/**
 * Drags a bottom sheet down from its head and closes it on a long drag or a flick. `drags` owns it, for unmount, and
 * a drag its owner cancels closes nothing.
 */
export function dragSheet(
  drags: Drags,
  head: DragTarget,
  surface: SheetSurface,
  down: Pick<PointerEvent, 'pointerId' | 'clientY'>,
  close: () => void,
): void {
  const startY = down.clientY;
  const startTime = performance.now();
  let dy = 0;
  surface.setAttribute('data-dragging', '');
  drags.start(head, down, {
    move: ev => {
      dy = Math.max(0, ev.clientY - startY);
      surface.style.transform = `translateY(${String(dy)}px)`;
    },
    end: released => {
      const speed = dy / Math.max(1, performance.now() - startTime);
      surface.removeAttribute('data-dragging');
      // Only a lifted finger commits. A cancel, by the browser or by an unmount where a detached sheet measures 0
      // high, puts the sheet back.
      if (
        released &&
        (dy > surface.offsetHeight * SWIPE_CLOSE_FRACTION || (dy >= SWIPE_FLICK_MIN_PX && speed > SWIPE_CLOSE_SPEED))
      ) {
        close();
      }
      surface.style.transform = '';
    },
  });
}
