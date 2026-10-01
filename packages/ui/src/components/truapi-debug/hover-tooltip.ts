// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zero-delay hover tooltip for any element under `root` carrying a
 * `data-tooltip` attribute. `pointerover` shows it, `pointermove` updates the
 * position, `pointerleave` hides it. Bypasses the browser-native `<title>`
 * delay so the information appears the instant the cursor lands.
 *
 * Delegated from `root` rather than bound per element, so a pane that rebuilds
 * its `innerHTML` on a timer keeps working without re-wiring. The tooltip is
 * positioned on every pointer move, so it is driven directly rather than
 * through signals.
 *
 * An element that also sets `data-tooltip-prose` gets a wrapped, width-capped
 * tooltip. The default stays on one line, which is what the short timeline
 * strings want.
 *
 * A move over the element already showing only writes the new position: the
 * panel's box is measured when the tooltip is shown (the panel does not move
 * under a hovering cursor), and the tooltip's own size only when its text
 * changes, so a pointermove never forces a layout. The size is measured with
 * the tooltip at the panel's left edge, where it has room for its full
 * width, so the right-edge clamp holds wherever it was first shown.
 *
 * Returns a function that removes the listeners.
 */
export function wireHoverTooltips(
  root: HTMLElement,
  tooltipEl: () => HTMLElement | undefined,
  panelEl: () => HTMLElement | undefined,
): () => void {
  /** The element the tooltip shows for, and what was measured for it. */
  let shownFor: Element | null = null;
  let panelRect: DOMRect | null = null;
  let size: { width: number; height: number } | null = null;

  const showAt = (el: Element, text: string, clientX: number, clientY: number): void => {
    const tooltip = tooltipEl();
    const panel = panelEl();
    if (tooltip === undefined || panel === undefined) {
      return;
    }
    const fresh = el !== shownFor || panelRect === null || !tooltip.classList.contains('visible');
    if (fresh) {
      // Measured before any write, so this read finds layout clean.
      panelRect = panel.getBoundingClientRect();
    }
    if (fresh || tooltip.textContent !== text) {
      tooltip.textContent = text;
      tooltip.classList.toggle('is-prose', el.hasAttribute('data-tooltip-prose'));
      tooltip.classList.add('visible');
      size = null;
    }
    shownFor = el;
    const rect = panelRect;
    if (rect === null) {
      return;
    }
    // Position (viewport-fixed): offset 12px below-right of the cursor,
    // then clamp to the viewport so the tooltip never gets cropped.
    const left = clientX - rect.left + 12;
    const top = clientY - rect.top + 16;
    if (size === null) {
      // Measured at the panel's left edge: a prose tooltip wraps to the room
      // right of its `left`, so measured near the right edge it would come
      // out narrow and tall, and the clamp below would under-correct.
      tooltip.style.left = '0px';
      const measured = tooltip.getBoundingClientRect();
      size = { width: measured.width, height: measured.height };
    }
    tooltip.style.left = `${String(left)}px`;
    tooltip.style.top = `${String(top)}px`;
    // Where the tooltip's edges land, from its size and the position just
    // written, as a fresh measure would find them.
    const right = rect.left + left + size.width;
    const bottom = rect.top + top + size.height;
    // Clamp right edge.
    if (right > rect.right - 4) {
      const adjusted = left - (right - rect.right) - 6;
      tooltip.style.left = `${String(Math.max(4, adjusted))}px`;
    }
    // Flip above the cursor rather than run off the bottom. A one-line
    // timeline tooltip almost never needs this. A wrapped prose one near the
    // foot of a bottom-docked panel always would.
    if (bottom > window.innerHeight - 4) {
      tooltip.style.top = `${String(top - size.height - 28)}px`;
    }
  };
  const hide = (): void => {
    tooltipEl()?.classList.remove('visible');
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
    if (tooltipEl()?.classList.contains('visible') !== true) {
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
