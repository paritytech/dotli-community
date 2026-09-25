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
 * Returns a function that removes the listeners.
 */
export function wireHoverTooltips(
  root: HTMLElement,
  tooltipEl: () => HTMLElement | undefined,
  panelEl: () => HTMLElement | undefined,
): () => void {
  const showAt = (
    text: string,
    prose: boolean,
    clientX: number,
    clientY: number,
  ): void => {
    const tooltip = tooltipEl();
    const panel = panelEl();
    if (tooltip === undefined || panel === undefined) {
      return;
    }
    tooltip.textContent = text;
    tooltip.classList.toggle("is-prose", prose);
    tooltip.classList.add("visible");
    // Position (viewport-fixed): offset 12px below-right of the cursor,
    // then clamp to the viewport so the tooltip never gets cropped.
    const panelRect = panel.getBoundingClientRect();
    const left = clientX - panelRect.left + 12;
    const top = clientY - panelRect.top + 16;
    tooltip.style.left = `${String(left)}px`;
    tooltip.style.top = `${String(top)}px`;
    // Clamp right edge.
    const ttRect = tooltip.getBoundingClientRect();
    const panelRight = panelRect.right;
    if (ttRect.right > panelRight - 4) {
      const adjusted = left - (ttRect.right - panelRight) - 6;
      tooltip.style.left = `${String(Math.max(4, adjusted))}px`;
    }
    // Flip above the cursor rather than run off the bottom. A one-line
    // timeline tooltip almost never needs this. A wrapped prose one near the
    // foot of a bottom-docked panel always would.
    if (ttRect.bottom > window.innerHeight - 4) {
      tooltip.style.top = `${String(top - ttRect.height - 28)}px`;
    }
  };
  const hide = (): void => {
    tooltipEl()?.classList.remove("visible");
  };
  const onPointerOver = (e: PointerEvent): void => {
    const target = e.target as Element | null;
    const el = target?.closest("[data-tooltip]");
    if (el === null || el === undefined) {
      return;
    }
    const text = el.getAttribute("data-tooltip");
    if (text === null) {
      return;
    }
    showAt(text, el.hasAttribute("data-tooltip-prose"), e.clientX, e.clientY);
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (tooltipEl()?.classList.contains("visible") !== true) {
      return;
    }
    const target = e.target as Element | null;
    const el = target?.closest("[data-tooltip]");
    if (el === null || el === undefined) {
      hide();
      return;
    }
    const text = el.getAttribute("data-tooltip");
    if (text === null) {
      hide();
      return;
    }
    showAt(text, el.hasAttribute("data-tooltip-prose"), e.clientX, e.clientY);
  };
  root.addEventListener("pointerover", onPointerOver);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerleave", hide);
  root.addEventListener("scroll", hide, { passive: true });
  return () => {
    root.removeEventListener("pointerover", onPointerOver);
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerleave", hide);
    root.removeEventListener("scroll", hide);
  };
}
