// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zero-delay tooltip for `[data-tooltip]` elements under `root`, skipping the native `title` delay.
 *
 * Delegated so elements can come and go. `data-tooltip-prose` wraps the text. A move over the shown element
 * only writes the position, since the panel box and tooltip size are cached, so pointermove never forces layout.
 */
export function wireHoverTooltips(
  root: HTMLElement,
  tooltipEl: () => HTMLElement | undefined,
  panelEl: () => HTMLElement | undefined,
): () => void {
  let shownFor: Element | null = null;
  let panelRect: DOMRect | null = null;
  let size: { width: number; height: number } | null = null;

  const showAt = (el: Element, text: string, clientX: number, clientY: number): void => {
    const tooltip = tooltipEl();
    const panel = panelEl();
    if (tooltip === undefined || panel === undefined) {
      return;
    }
    const fresh = el !== shownFor || panelRect === null || !tooltip.hasAttribute('data-visible');
    if (fresh) {
      // Measured before any write, so this read finds layout clean.
      panelRect = panel.getBoundingClientRect();
    }
    if (fresh || tooltip.textContent !== text) {
      tooltip.textContent = text;
      tooltip.toggleAttribute('data-prose', el.hasAttribute('data-tooltip-prose'));
      tooltip.setAttribute('data-visible', '');
      size = null;
    }
    shownFor = el;
    const rect = panelRect;
    if (rect === null) {
      return;
    }
    const left = clientX - rect.left + 12;
    const top = clientY - rect.top + 16;
    if (size === null) {
      // Measured at the left edge, since a prose tooltip near the right edge wraps narrow and the clamp under-corrects.
      tooltip.style.left = '0px';
      const measured = tooltip.getBoundingClientRect();
      size = { width: measured.width, height: measured.height };
    }
    tooltip.style.left = `${String(left)}px`;
    tooltip.style.top = `${String(top)}px`;
    const right = rect.left + left + size.width;
    const bottom = rect.top + top + size.height;
    if (right > rect.right - 4) {
      const adjusted = left - (right - rect.right) - 6;
      tooltip.style.left = `${String(Math.max(4, adjusted))}px`;
    }
    if (bottom > window.innerHeight - 4) {
      tooltip.style.top = `${String(top - size.height - 28)}px`;
    }
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
