// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Shown modal layers and the inertness they put on the page. Apart from ModalLayer so anchored surfaces can
// ask whether one is shown without loading it.

/** In opening order. The page answers to the last. */
const shownLayers: HTMLElement[] = [];
/** Only what the layers made inert, so elements inert for other reasons stay so. */
const madeInert = new Set<HTMLElement>();

export function topLayer(): HTMLElement | undefined {
  return shownLayers.at(-1);
}

/** An anchored surface must not cover a shown modal layer. */
export function modalLayerShown(): boolean {
  return shownLayers.length > 0;
}

/**
 * Makes the top layer the only part of the page that answers, as showModal() would.
 * Popovers are skipped since open ones close as a layer shows. So is `data-over-sheets` (the phone bar) under a
 * sheet, because its controls hand the sheet over.
 */
function syncInert(): void {
  const top = shownLayers.at(-1);
  for (const el of madeInert) {
    if (top === undefined || el === top) {
      el.removeAttribute('inert');
      madeInert.delete(el);
    }
  }
  if (top === undefined) {
    return;
  }
  const sheet = top.getAttribute('data-layout') === 'sheet';
  for (const el of document.body.children) {
    if (
      el instanceof HTMLElement &&
      el !== top &&
      !el.hasAttribute('inert') &&
      !el.hasAttribute('popover') &&
      !(sheet && el.hasAttribute('data-over-sheets'))
    ) {
      el.setAttribute('inert', '');
      madeInert.add(el);
    }
  }
}

/** Closes all but manual popovers, as showModal() does. */
function closePopovers(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[popover]:not([popover="manual"])')) {
    el.hidePopover();
  }
}

export function showLayer(layer: HTMLElement): void {
  closePopovers();
  shownLayers.push(layer);
  syncInert();
}

export function hideLayer(layer: HTMLElement): void {
  const index = shownLayers.indexOf(layer);
  if (index !== -1) {
    shownLayers.splice(index, 1);
  }
  syncInert();
}
