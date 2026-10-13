// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Topbar popovers, menus and the pairing modal register here so auto-hide keeps the bar up
// while one is open or focused, even when it is portalled outside `#topbar`.

export interface TopbarSurface {
  element: () => HTMLElement | undefined;
  /** Open as last set (not as last rendered). */
  open: () => boolean;
}

const surfaces = new Set<TopbarSurface>();

export function registerTopbarSurface(surface: TopbarSurface): () => void {
  surfaces.add(surface);
  return () => {
    surfaces.delete(surface);
  };
}

export function anyTopbarSurfaceOpen(): boolean {
  return [...surfaces].some(surface => surface.open());
}

export function topbarSurfaceContains(el: Element): boolean {
  return [...surfaces].some(surface => surface.element()?.contains(el) === true);
}
