// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The modal layers shown, and what showing one does to the rest of the page.
// Apart from ModalLayer, so anchored surfaces can ask whether one is shown
// without loading it.

/** The shown layers, in opening order: the page answers to the last. */
const shownLayers: HTMLElement[] = [];
/** The body's children the shown layers made inert, given back as they close. */
const madeInert = new Set<HTMLElement>();

/** The layer the page answers to, if one is shown. */
export function topLayer(): HTMLElement | undefined {
  return shownLayers.at(-1);
}

/** Whether a modal layer is shown, which an anchored surface must not cover. */
export function modalLayerShown(): boolean {
  return shownLayers.length > 0;
}

/**
 * Leaves the top layer the only part of the page that answers, as
 * showModal() would: the body's other children go inert, the layers under
 * it included. Popovers stay out of it: the ones open are closed as a layer
 * shows, and the rest can only open from inside it. So does what is marked
 * `data-over-sheets` (the phone bar, drawn over the sheets) while the top
 * layer is a sheet: its controls hand the sheet over (ModalLayer).
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

/** What showModal() does to the popovers open as a dialog shows: closes all but the manual ones. */
function closePopovers(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[popover]:not([popover="manual"])')) {
    el.hidePopover();
  }
}

/** Shows `layer` over the page: open popovers close, and the rest goes inert. */
export function showLayer(layer: HTMLElement): void {
  closePopovers();
  shownLayers.push(layer);
  syncInert();
}

/** Lets go of `layer`, giving the page back to the layer under it, or to the user. */
export function hideLayer(layer: HTMLElement): void {
  const index = shownLayers.indexOf(layer);
  if (index !== -1) {
    shownLayers.splice(index, 1);
  }
  syncInert();
}
