// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Shown layers and the inertness the modal ones put on the page.

export type LayerLayout = 'center' | 'sheet' | 'side' | 'topbar-end';

type ShownLayer = { element: HTMLElement; layout: LayerLayout };

/** In opening order, so a layer that turns modal while open stays under those opened after it. */
const shownLayers: ShownLayer[] = [];
/** Only what the layers made inert, so elements inert for other reasons stay so. */
const madeInert = new Set<HTMLElement>();

/** Whether a layer in `layout` is the only part of the page that answers. A side panel sits beside the page. */
export function isModalLayout(layout: LayerLayout): boolean {
  switch (layout) {
    case 'center':
    case 'sheet':
    case 'topbar-end':
      return true;
    case 'side':
      return false;
  }
}

/** The last shown modal layer, which the page answers to. */
export function topLayer(): HTMLElement | undefined {
  return findTopModal()?.element;
}

export function showLayer(layer: HTMLElement, layout: LayerLayout): void {
  if (isModalLayout(layout)) {
    closePopovers();
  }
  shownLayers.push({ element: layer, layout });
  syncDepth();
  syncInert();
}

/**
 * Records a shown layer's new layout, which makes it modal or not in its place in the opening order. Never throws,
 * and a layer that is not shown is ignored.
 */
export function setLayerLayout(layer: HTMLElement, layout: LayerLayout): void {
  const shown = shownLayers.find(entry => entry.element === layer);
  if (shown === undefined || shown.layout === layout) {
    return;
  }
  if (isModalLayout(layout) && !isModalLayout(shown.layout)) {
    closePopovers();
  }
  shown.layout = layout;
  syncInert();
}

export function hideLayer(layer: HTMLElement): void {
  const index = shownLayers.findIndex(entry => entry.element === layer);
  if (index !== -1) {
    shownLayers.splice(index, 1);
  }
  layer.style.removeProperty('--layer-depth');
  syncDepth();
  syncInert();
}

function findTopModal(): ShownLayer | undefined {
  return shownLayers.filter(entry => isModalLayout(entry.layout)).at(-1);
}

/**
 * Makes the top modal layer the only part of the page that answers, as showModal() would.
 * Popovers are skipped since open ones close as a modal layer shows. So is `data-over-sheets` (the phone bar) under a
 * sheet, because its controls hand the sheet over.
 */
function syncInert(): void {
  const top = findTopModal();
  for (const el of madeInert) {
    if (top === undefined || !isInertUnder(el, top)) {
      el.removeAttribute('inert');
      madeInert.delete(el);
    }
  }
  if (top === undefined) {
    return;
  }
  for (const el of document.body.children) {
    if (el instanceof HTMLElement && !el.hasAttribute('inert') && isInertUnder(el, top)) {
      el.setAttribute('inert', '');
      madeInert.add(el);
    }
  }
}

function isInertUnder(el: HTMLElement, top: ShownLayer): boolean {
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

/** Paints each shown layer over those opened before it, whatever their order in the page. */
function syncDepth(): void {
  for (const [index, { element }] of shownLayers.entries()) {
    element.style.setProperty('--layer-depth', String(index));
  }
}
