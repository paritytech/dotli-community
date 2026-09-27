// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, type ReadableStore } from "./create-store";

/** Up while loading, fading out once dismissed, then gone. */
export type LoadingScreenPhase = "active" | "dismissing" | "gone";

/** What the loading screen shows. Written only by `loading-controller.ts`. */
export interface LoadingState {
  /** The bar, 0 to 100. Fractional: the shown number is rounded. */
  progress: number;
  /** The headline as it stands this frame, part-typed while it turns over. */
  statusText: string;
  /** The headline dims while it turns over and is 1 otherwise. */
  statusOpacity: number;
  /** The whole sentence for screen readers, set once per line. */
  srText: string;
  /** The stall warning under the headline, or null when hidden. */
  warning: string | null;
  phase: LoadingScreenPhase;
}

// Matches the static markup in apps/host/index.html, which paints first.
const loading = createSyncStore<LoadingState>({
  progress: 0,
  statusText: "Reaching out",
  statusOpacity: 1,
  srText: "",
  warning: null,
  phase: "active",
});

export const loadingStore: ReadableStore<LoadingState> = loading;
export const getLoadingState = loading.get;

/** Change some fields and keep the rest. */
export function updateLoading(patch: Partial<LoadingState>): void {
  loading.set({ ...loading.get(), ...patch });
}
