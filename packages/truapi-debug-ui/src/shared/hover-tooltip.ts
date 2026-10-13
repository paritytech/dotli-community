// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createTooltipPlacer } from './tooltip-place.js';

/**
 * Zero-delay tooltip for `[data-tooltip]` elements under `root`, skipping the native `title` delay.
 *
 * Delegated so elements can come and go. `data-tooltip-prose` wraps the text. The placer caches the panel box and
 * tooltip size, so pointermove never forces layout.
 */
export function wireHoverTooltips(
  root: HTMLElement,
  tooltipEl: () => HTMLElement | undefined,
  panelEl: () => HTMLElement | undefined,
): () => void {
  const place = createTooltipPlacer<Element>({
    readPanel: () => panelEl()?.getBoundingClientRect() ?? { left: 0, top: 0, right: 0 },
    writeText: (text, el) => {
      const tooltip = tooltipEl();
      if (tooltip !== undefined) {
        tooltip.textContent = text;
        tooltip.toggleAttribute('data-prose', el.hasAttribute('data-tooltip-prose'));
        tooltip.setAttribute('data-visible', '');
      }
    },
    measure: () => {
      const tooltip = tooltipEl();
      if (tooltip === undefined) {
        return { width: 0, height: 0 };
      }
      tooltip.style.left = '0px';
      const measured = tooltip.getBoundingClientRect();
      return { width: measured.width, height: measured.height };
    },
  });

  const showAt = (el: Element, text: string, clientX: number, clientY: number): void => {
    const tooltip = tooltipEl();
    if (tooltip === undefined || panelEl() === undefined) {
      return;
    }
    const at = place(el, text, tooltip.hasAttribute('data-visible'), { x: clientX, y: clientY }, window.innerHeight);
    tooltip.style.left = `${String(at.left)}px`;
    tooltip.style.top = `${String(at.top)}px`;
  };
  const hide = (): void => {
    tooltipEl()?.removeAttribute('data-visible');
  };
  const onPointerOver = (e: PointerEvent): void => {
    const target = e.target as Element | null;
    const el = target?.closest('[data-tooltip]');
    if (el === null || el === undefined) {
      return;
    }
    const text = el.getAttribute('data-tooltip');
    if (text === null) {
      return;
    }
    showAt(el, text, e.clientX, e.clientY);
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (tooltipEl()?.hasAttribute('data-visible') !== true) {
      return;
    }
    const target = e.target as Element | null;
    const el = target?.closest('[data-tooltip]');
    if (el === null || el === undefined) {
      hide();
      return;
    }
    const text = el.getAttribute('data-tooltip');
    if (text === null) {
      hide();
      return;
    }
    showAt(el, text, e.clientX, e.clientY);
  };
  root.addEventListener('pointerover', onPointerOver);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerleave', hide);
  root.addEventListener('scroll', hide, { passive: true });
  return () => {
    root.removeEventListener('pointerover', onPointerOver);
    root.removeEventListener('pointermove', onPointerMove);
    root.removeEventListener('pointerleave', hide);
    root.removeEventListener('scroll', hide);
  };
}
