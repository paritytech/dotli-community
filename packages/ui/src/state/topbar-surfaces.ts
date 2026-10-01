// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's surfaces (its popovers, menus and the pairing modal), as
// createPopover registers them: the auto-hide keeps the bar on screen while
// one is open or holds the focus, wherever it renders (most portal into the
// body, outside `#topbar`).

export interface TopbarSurface {
  /** The surface's element, once rendered. */
  element: () => HTMLElement | undefined;
  /** Open as last set (not as last rendered). */
  open: () => boolean;
}

const surfaces = new Set<TopbarSurface>();

/** Register `surface`; returns the unregister. */
export function registerTopbarSurface(surface: TopbarSurface): () => void {
  surfaces.add(surface);
  return () => {
    surfaces.delete(surface);
  };
}

/** Some surface is open. */
export function anyTopbarSurfaceOpen(): boolean {
  return [...surfaces].some(surface => surface.open());
}

/** Some surface holds `el`. */
export function topbarSurfaceContains(el: Element): boolean {
  return [...surfaces].some(surface => surface.element()?.contains(el) === true);
}
