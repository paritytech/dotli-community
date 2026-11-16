// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { registerStoreStateReset } from '@dotli/shared';
import type { TrackedLayer } from '@dotli/ui';

// A floating surface of the topbar, such as a popover, a menu or a modal, may be portalled outside the bar.
const surfaces = new Set<TrackedLayer>();

/** The topbar's registered surfaces, so the bar can tell whether one is open or holds an element. */
export const topbarSurfaces = {
  /** Tracks `surface` until the returned function runs. Never throws. */
  register,
  /** Returns whether any registered surface is open. Never throws. */
  isAnyOpen,
  /** Returns whether `element` sits inside any registered surface. Never throws. */
  contains,
};

registerStoreStateReset(() => {
  surfaces.clear();
});

function register(surface: TrackedLayer): () => void {
  surfaces.add(surface);
  function unregister(): void {
    surfaces.delete(surface);
  }
  return unregister;
}

function isAnyOpen(): boolean {
  return [...surfaces].some(surface => surface.open());
}

function contains(element: Element): boolean {
  return [...surfaces].some(surface => surface.element()?.contains(element) === true);
}
