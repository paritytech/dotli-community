// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { wireHoverTooltips } from '../../src/components/truapi-debug/hover-tooltip.js';

const PANEL = { left: 0, top: 0, right: 1000, bottom: 600 };
/** A prose tooltip's natural width; it wraps narrower when less room is left. */
const NATURAL_WIDTH = 300;
const LINE_HEIGHT = 20;
const TEXT_WIDTH = 900;

/**
 * happy-dom lays nothing out: the tooltip measures as an absolutely placed
 * prose box does, shrinking to the room right of its `left` and growing
 * taller as it wraps.
 */
function setup(): {
  root: HTMLElement;
  tooltip: HTMLElement;
  target: HTMLElement;
  measures: () => number;
  dispose: () => void;
} {
  const panel = document.createElement('div');
  const root = document.createElement('div');
  const tooltip = document.createElement('div');
  const target = document.createElement('span');
  target.setAttribute('data-tooltip', 'A long explanation');
  target.setAttribute('data-tooltip-prose', '');
  root.append(target);
  panel.append(root, tooltip);
  document.body.append(panel);
  panel.getBoundingClientRect = () => PANEL as DOMRect;
  let measures = 0;
  tooltip.getBoundingClientRect = () => {
    measures += 1;
    const left = Number.parseFloat(tooltip.style.left);
    const width = Math.min(NATURAL_WIDTH, PANEL.right - left);
    const lines = Math.ceil(TEXT_WIDTH / width);
    return { width, height: lines * LINE_HEIGHT } as DOMRect;
  };
  const dispose = wireHoverTooltips(
    root,
    () => tooltip,
    () => panel,
  );
  return { root, tooltip, target, measures: () => measures, dispose };
}

function pointer(el: Element, type: string, x: number, y: number): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y }));
}

function rightEdge(tooltip: HTMLElement): number {
  return tooltip.getBoundingClientRect().width + Number.parseFloat(tooltip.style.left);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('hover tooltip clamp', () => {
  it("As a dotli developer hovering near the panel's right edge, a wrapped tooltip stays inside the panel", () => {
    // Given
    const { tooltip, target, dispose } = setup();

    // When: shown near the right edge, where it first wraps narrow and tall.
    pointer(target, 'pointerover', 900, 40);

    // Then
    expect(rightEdge(tooltip)).toBeLessThanOrEqual(PANEL.right - 4);
    expect(tooltip.getBoundingClientRect().width).toBe(NATURAL_WIDTH);

    // When: moves along the edge.
    for (let x = 901; x <= 905; x++) {
      pointer(target, 'pointermove', x, 40);
    }

    // Then
    expect(rightEdge(tooltip)).toBeLessThanOrEqual(PANEL.right - 4);
    dispose();
  });

  it('As a dotli developer, moving over the same tooltip after the clamp measured it does not measure again', () => {
    // Given
    const { target, measures, dispose } = setup();
    pointer(target, 'pointerover', 900, 40);
    const before = measures();

    // When
    for (let x = 901; x <= 905; x++) {
      pointer(target, 'pointermove', x, 40);
    }

    // Then
    expect(measures()).toBe(before);
    dispose();
  });

  it('As a dotli developer, a tooltip whose text changes under the cursor is measured again', () => {
    // Given
    const { target, measures, dispose } = setup();
    pointer(target, 'pointerover', 100, 40);
    const before = measures();

    // When
    target.setAttribute('data-tooltip', 'Another explanation');
    pointer(target, 'pointermove', 101, 40);

    // Then
    expect(measures()).toBe(before + 1);
    dispose();
  });
});
