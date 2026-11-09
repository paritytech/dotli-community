// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Shown modal layers and the inertness they put on the page.

export type LayerLayout = 'center' | 'sheet' | 'topbar-end';

type ShownLayer = { element: HTMLElement; layout: LayerLayout };

/** In opening order. The page answers to the last. */
const shownLayers: ShownLayer[] = [];
/** Only what the layers made inert, so elements inert for other reasons stay so. */
const madeInert = new Set<HTMLElement>();

export function topLayer(): HTMLElement | undefined {
  return shownLayers.at(-1)?.element;
}

/**
 * Makes the top layer the only part of the page that answers, as showModal() would.
 * Popovers are skipped since open ones close as a layer shows. So is `data-over-sheets` (the phone bar) under a
 * sheet, because its controls hand the sheet over.
 */
function syncInert(): void {
  const top = shownLayers.at(-1);
  for (const el of madeInert) {
    if (top === undefined || !shouldBeInert(el, top)) {
      el.removeAttribute('inert');
      madeInert.delete(el);
    }
  }
  if (top === undefined) {
    return;
  }
  for (const el of document.body.children) {
    if (el instanceof HTMLElement && !el.hasAttribute('inert') && shouldBeInert(el, top)) {
      el.setAttribute('inert', '');
      madeInert.add(el);
    }
  }
}

function shouldBeInert(el: HTMLElement, top: ShownLayer): boolean {
  return (
    el !== top.element &&
    !el.hasAttribute('popover') &&
    !(top.layout === 'sheet' && el.hasAttribute('data-over-sheets'))
  );
}

/** Closes all but manual popovers, as showModal() does. */
function closePopovers(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[popover]:not([popover="manual"])')) {
    el.hidePopover();
  }
}

export function showLayer(layer: HTMLElement, layout: LayerLayout): void {
  closePopovers();
  shownLayers.push({ element: layer, layout });
  syncInert();
}

/** Records a shown layer's new layout. Never throws, and a layer that is not shown is ignored. */
export function setLayerLayout(layer: HTMLElement, layout: LayerLayout): void {
  const shown = shownLayers.find(entry => entry.element === layer);
  if (shown === undefined || shown.layout === layout) {
    return;
  }
  shown.layout = layout;
  syncInert();
}

export function hideLayer(layer: HTMLElement): void {
  const index = shownLayers.findIndex(entry => entry.element === layer);
  if (index !== -1) {
    shownLayers.splice(index, 1);
  }
  syncInert();
}
