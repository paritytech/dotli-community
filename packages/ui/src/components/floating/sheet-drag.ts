// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Drags } from '../drag.js';

/** A swipe past this share of the sheet's height closes it. */
const SWIPE_CLOSE_FRACTION = 0.3;
/** So does one faster than this, in px/ms... */
const SWIPE_CLOSE_SPEED = 0.5;
/** ...that went at least this far, so a tap's jitter is no flick. */
const SWIPE_FLICK_MIN_PX = 24;

/**
 * Drags a bottom sheet down from its head and closes it on a long drag or a flick. `drags` owns it, for unmount.
 */
export function dragSheet(
  drags: Drags,
  head: HTMLElement,
  surface: HTMLElement,
  down: PointerEvent,
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
    end: () => {
      const speed = dy / Math.max(1, performance.now() - startTime);
      surface.removeAttribute('data-dragging');
      if (dy > surface.offsetHeight * SWIPE_CLOSE_FRACTION || (dy >= SWIPE_FLICK_MIN_PX && speed > SWIPE_CLOSE_SPEED)) {
        close();
      }
      surface.style.transform = '';
    },
  });
}
