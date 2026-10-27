// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createTooltipPlacer } from './createTooltipPlacer.js';

type WireHoverTooltipsParams = {
  /** The element whose `[data-tooltip]` descendants show a tooltip. */
  root: HTMLElement;
  /** The tooltip element, once mounted. */
  tooltip: () => HTMLElement | undefined;
  /** The panel the tooltip stays inside, once mounted. */
  panel: () => HTMLElement | undefined;
};

type ShowAtParams = {
  /** The hovered `[data-tooltip]` element. */
  element: Element;
  text: string;
  clientX: number;
  clientY: number;
};

type HoveredTooltip = Pick<ShowAtParams, 'element' | 'text'>;

/**
 * Zero-delay tooltip for `[data-tooltip]` elements under `root`, skipping the native `title` delay.
 *
 * Delegated so elements can come and go. `data-tooltip-prose` wraps the text. The placer caches the panel box and
 * tooltip size, so pointermove never forces layout. Returns its dispose, which removes the listeners. Never throws.
 */
export function wireHoverTooltips({ root, tooltip, panel }: WireHoverTooltipsParams): () => void {
  const place = createTooltipPlacer<Element>({
    readPanel: () => panel()?.getBoundingClientRect() ?? { left: 0, top: 0, right: 0 },
    writeText(text, element) {
      const node = tooltip();
      if (node === undefined) {
        return;
      }
      node.textContent = text;
      node.toggleAttribute('data-prose', element.hasAttribute('data-tooltip-prose'));
      node.setAttribute('data-visible', '');
    },
    measure() {
      const node = tooltip();
      if (node === undefined) {
        return { width: 0, height: 0 };
      }
      node.style.left = '0px';
      const measured = node.getBoundingClientRect();
      return { width: measured.width, height: measured.height };
    },
  });

  function showAt({ element, text, clientX, clientY }: ShowAtParams): void {
    const node = tooltip();
    if (node === undefined || panel() === undefined) {
      return;
    }
    const at = place({
      element,
      text,
      shown: node.hasAttribute('data-visible'),
      pointer: { x: clientX, y: clientY },
      viewportHeight: window.innerHeight,
    });
    node.style.left = `${String(at.left)}px`;
    node.style.top = `${String(at.top)}px`;
  }
  function hide(): void {
    tooltip()?.removeAttribute('data-visible');
  }
  function handlePointerOver(event: PointerEvent): void {
    const hovered = findTooltip(event.target);
    if (hovered === null) {
      return;
    }
    showAt({ ...hovered, clientX: event.clientX, clientY: event.clientY });
  }
  function handlePointerMove(event: PointerEvent): void {
    if (tooltip()?.hasAttribute('data-visible') !== true) {
      return;
    }
    const hovered = findTooltip(event.target);
    if (hovered === null) {
      hide();
      return;
    }
    showAt({ ...hovered, clientX: event.clientX, clientY: event.clientY });
  }
  root.addEventListener('pointerover', handlePointerOver);
  root.addEventListener('pointermove', handlePointerMove);
  root.addEventListener('pointerleave', hide);
  root.addEventListener('scroll', hide, { passive: true });
  return dispose;

  function dispose(): void {
    root.removeEventListener('pointerover', handlePointerOver);
    root.removeEventListener('pointermove', handlePointerMove);
    root.removeEventListener('pointerleave', hide);
    root.removeEventListener('scroll', hide);
  }
}

/** The `[data-tooltip]` element at or above `target`, with its text, or null when there is none. */
function findTooltip(target: EventTarget | null): HoveredTooltip | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const element = target.closest('[data-tooltip]');
  const text = element?.getAttribute('data-tooltip') ?? null;
  if (element === null || text === null) {
    return null;
  }
  return { element, text };
}
