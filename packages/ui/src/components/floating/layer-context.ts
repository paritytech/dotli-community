// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the page around a layer gives it. The page provides these, so the layers import nothing of the page.

import { createContext } from 'solid-js';

/** A floating layer as a tracker sees it. */
export interface TrackedLayer {
  element: () => HTMLElement | undefined;
  /** Open as last set (not as last rendered). */
  open: () => boolean;
}

/** Tracks a layer until the returned function runs. */
export type TrackLayer = (layer: TrackedLayer) => () => void;

/** Tracks every floating layer rendered below it, from its creation until its disposal. Untracked without one. */
export const LayerTracker = createContext<TrackLayer | null>(null);

export interface AnchorBoundary {
  /** Takes focus back for a trigger that cannot take it, such as one the region has hidden. */
  fallbackFocus: () => HTMLElement | undefined;
}

/** Without one, focus goes back to the trigger only. */
export const AnchorBoundary = createContext<AnchorBoundary | null>(null);

/** Where focus goes when a closing modal's restore target has left the page. Nowhere without one. */
export const ModalFocusFallback = createContext<() => HTMLElement | undefined>(() => undefined);
