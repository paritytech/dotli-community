// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
  type ComputePositionConfig,
  type Placement as FloatingPlacement,
  type SizeOptions,
} from '@floating-ui/dom';
import { createReporter, defineCount } from '@dotli/metrics';
import type { TriggerPlacement } from './FloatingLayer.js';

type GetPositionConfigParams = {
  /** The space between the trigger and the surface, in px. */
  gap: number;
  /** Writes the room the pass found. */
  apply: SizeOptions['apply'];
};

const report = createReporter({ flow: 'ui' });
const placementMetric = defineCount<'error'>('floating.placement');

/** Keeps a surface clear of the visible area's edges. */
const EDGE_PADDING = 8;
const ROOM = '--layer-room';
const ANCHOR_WIDTH = '--layer-anchor-width';

const SIDES = {
  'trigger-start': { preferred: 'bottom-start', fallback: 'top-start' },
  'trigger-end': { preferred: 'bottom-end', fallback: 'top-end' },
} satisfies Record<TriggerPlacement, { preferred: FloatingPlacement; fallback: FloatingPlacement }>;

type Params = {
  trigger: HTMLElement;
  surface: HTMLElement;
  placement: TriggerPlacement;
};

/**
 * Places the surface against its trigger and keeps it there as the page scrolls, resizes or shows the keyboard, until
 * the returned stop is called. It writes `left` and `top`, the side it took as `data-side`, and the room left in the
 * visible area and the trigger's width as `--layer-room` and `--layer-anchor-width`. A failed pass leaves the surface
 * where the last one put it.
 */
export function placeAtTrigger({ trigger, surface, placement }: Params): () => void {
  function writeRoom({ availableHeight, rects }: Parameters<NonNullable<SizeOptions['apply']>>[0]): void {
    surface.style.setProperty(ROOM, `${String(Math.max(0, availableHeight))}px`);
    surface.style.setProperty(ANCHOR_WIDTH, `${String(rects.reference.width)}px`);
  }

  function place(): void {
    const room = surface.style.getPropertyValue(ROOM);
    // The surface takes its content's height up to its CSS cap, so flip judges the content and not the room the last
    // pass gave it, and a list squeezed on one side can go back to the other.
    surface.style.removeProperty(ROOM);
    const gap = parseFloat(getComputedStyle(surface).getPropertyValue('--pop-gap'));
    void computePosition(trigger, surface, getPositionConfig(placement, { gap, apply: writeRoom })).then(
      ({ x, y, placement: taken }) => {
        surface.style.left = `${String(x)}px`;
        surface.style.top = `${String(y)}px`;
        // Only the two vertical sides are offered.
        surface.dataset['side'] = taken.startsWith('top') ? 'top' : 'bottom';
      },
      (error: unknown) => {
        surface.style.setProperty(ROOM, room);
        report.defect(error, {
          step: 'place',
          metric: placementMetric,
          message: '[dot.li ui] Placing a floating layer failed',
        });
      },
    );
  }

  return autoUpdate(trigger, surface, place);
}

/**
 * The Floating UI options for a placement: below the trigger when the content fits there, else the side with more
 * room, kept on screen across and sized to the room it gets.
 */
export function getPositionConfig(
  placement: TriggerPlacement,
  { gap, apply }: GetPositionConfigParams,
): ComputePositionConfig {
  const { preferred, fallback } = SIDES[placement];
  return {
    strategy: 'fixed',
    placement: preferred,
    middleware: [
      offset(gap),
      // Across is shift's, so flip only weighs the room above and below.
      flip({ fallbackPlacements: [fallback], fallbackStrategy: 'bestFit', crossAxis: false, padding: EDGE_PADDING }),
      shift({ padding: EDGE_PADDING }),
      size({ padding: EDGE_PADDING, apply }),
    ],
  };
}
