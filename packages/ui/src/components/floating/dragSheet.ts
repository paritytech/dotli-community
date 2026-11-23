// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from '@dotli/shared';
import type { Drags } from '../createDrags.js';
import type { DragTarget } from '../startDrag.js';

/** What the drag moves, so a spec can stand in for the sheet's element. */
export type SheetSurface = Pick<HTMLElement, 'setAttribute' | 'removeAttribute' | 'offsetHeight' | 'offsetWidth'> & {
  style: Pick<CSSStyleDeclaration, 'transform'>;
};

/** The screen edge a sheet rests on. A swipe toward it closes the sheet. */
type SheetEdge = 'bottom' | 'right';

type Params = {
  /** The drags of the sheet's component, which cancel this one on unmount. */
  drags: Drags;
  /** The sheet's head, where the pointer went down. */
  head: DragTarget;
  /** The sheet the drag moves, marked while the drag runs. */
  surface: SheetSurface;
  /** The pointerdown that starts the drag. */
  down: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>;
  /** Closes the sheet. */
  close: () => void;
  /** The bottom by default. */
  edge?: SheetEdge | undefined;
  /** The page's own by default. A flick's speed is measured on their clock. */
  timers?: Timers | undefined;
};

/** Where the pointer is along the swipe, how far the sheet spans that way, and how it moves that way. */
const EDGE_AXES = {
  bottom: { position: 'clientY', size: 'offsetHeight', translate: 'translateY' },
  right: { position: 'clientX', size: 'offsetWidth', translate: 'translateX' },
} satisfies Record<
  SheetEdge,
  {
    position: 'clientX' | 'clientY';
    size: 'offsetHeight' | 'offsetWidth';
    translate: 'translateX' | 'translateY';
  }
>;

/** A swipe past this share of the sheet's span closes it. */
const SWIPE_CLOSE_FRACTION = 0.3;
/** So does one faster than this, in px/ms... */
const SWIPE_CLOSE_SPEED = 0.5;
/** ...that went at least this far, so a tap's jitter is no flick. */
const SWIPE_FLICK_MIN_PX = 24;

/**
 * Drags a sheet from its head toward the edge it rests on, and closes it on a long drag or a flick. `drags` owns it,
 * for unmount, and a drag its owner cancels closes nothing. Throws only what the selection lock throws, and its drag's
 * end only what `close` throws.
 */
export function dragSheet({ drags, head, surface, down, close, edge = 'bottom', timers = realTimers }: Params): void {
  const axis = EDGE_AXES[edge];
  const start = down[axis.position];
  const startTime = timers.now();
  let distance = 0;
  surface.setAttribute('data-dragging', '');
  drags.start({
    target: head,
    down,
    handlers: {
      move(event) {
        distance = Math.max(0, event[axis.position] - start);
        surface.style.transform = `${axis.translate}(${String(distance)}px)`;
      },
      end(released) {
        const speed = distance / Math.max(1, timers.now() - startTime);
        surface.removeAttribute('data-dragging');
        // Only a lifted finger commits. A cancel, by the browser or by an unmount where a detached sheet measures 0
        // across, puts the sheet back.
        if (
          released &&
          (distance > surface[axis.size] * SWIPE_CLOSE_FRACTION ||
            (distance >= SWIPE_FLICK_MIN_PX && speed > SWIPE_CLOSE_SPEED))
        ) {
          close();
        }
        surface.style.transform = '';
      },
    },
  });
}
