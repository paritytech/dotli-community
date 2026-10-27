// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from '@dotli/shared';
import type { Drags } from '../createDrags.js';
import type { DragTarget } from '../startDrag.js';

/** What the drag moves, so a spec can stand in for the sheet's element. */
export type SheetSurface = Pick<HTMLElement, 'setAttribute' | 'removeAttribute' | 'offsetHeight'> & {
  style: Pick<CSSStyleDeclaration, 'transform'>;
};

type Params = {
  /** The drags of the sheet's component, which cancel this one on unmount. */
  drags: Drags;
  /** The sheet's head, where the pointer went down. */
  head: DragTarget;
  /** The sheet the drag moves, marked while the drag runs. */
  surface: SheetSurface;
  /** The pointerdown that starts the drag. */
  down: Pick<PointerEvent, 'pointerId' | 'clientY'>;
  /** Closes the sheet. */
  close: () => void;
  /** The page's own by default. A flick's speed is measured on their clock. */
  timers?: Timers | undefined;
};

/** A swipe past this share of the sheet's height closes it. */
const SWIPE_CLOSE_FRACTION = 0.3;
/** So does one faster than this, in px/ms... */
const SWIPE_CLOSE_SPEED = 0.5;
/** ...that went at least this far, so a tap's jitter is no flick. */
const SWIPE_FLICK_MIN_PX = 24;

/**
 * Drags a bottom sheet down from its head and closes it on a long drag or a flick. `drags` owns it, for unmount, and
 * a drag its owner cancels closes nothing. Throws only what the selection lock throws, and its drag's end only what
 * `close` throws.
 */
export function dragSheet({ drags, head, surface, down, close, timers = realTimers }: Params): void {
  const startY = down.clientY;
  const startTime = timers.now();
  let distance = 0;
  surface.setAttribute('data-dragging', '');
  drags.start({
    target: head,
    down,
    handlers: {
      move(event) {
        distance = Math.max(0, event.clientY - startY);
        surface.style.transform = `translateY(${String(distance)}px)`;
      },
      end(released) {
        const speed = distance / Math.max(1, timers.now() - startTime);
        surface.removeAttribute('data-dragging');
        // Only a lifted finger commits. A cancel, by the browser or by an unmount where a detached sheet measures 0
        // high, puts the sheet back.
        if (
          released &&
          (distance > surface.offsetHeight * SWIPE_CLOSE_FRACTION ||
            (distance >= SWIPE_FLICK_MIN_PX && speed > SWIPE_CLOSE_SPEED))
        ) {
          close();
        }
        surface.style.transform = '';
      },
    },
  });
}
