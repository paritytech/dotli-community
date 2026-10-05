// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, shallowEqual, type ReadableStore } from './create-store.js';

/**
 * Up while loading, fading out once dismissed, then gone. `"gone"` is
 * terminal: the controller starts no timer once it is reached.
 */
export type LoadingScreenPhase = 'active' | 'dismissing' | 'gone';

/**
 * A piece of the step line: plain text, or the name being loaded, which the
 * screen draws with its TLD dimmed.
 */
export type StepPart = string | { host: string; tld: string };

/** What the loading screen shows. Written only by `loading-controller.ts`. */
export interface LoadingState {
  /** The bar, 0 to 100. Fractional: the shown number is rounded. */
  progress: number;
  /** The step line, the running stage's opening sentence. */
  step: readonly StepPart[];
  /** The explanation line as it stands this frame, part-typed while it turns over. */
  explanation: string;
  /** The explanation dims while it turns over and is 1 otherwise. */
  explanationOpacity: number;
  /** The whole sentence for screen readers, set once per line. */
  srText: string;
  /** The stall warning under the bar, or null when hidden. */
  warning: string | null;
  phase: LoadingScreenPhase;
}

// What the host page's build-time render of the loading screen shows, which
// paints first.
const loading = createSyncStore<LoadingState>(
  'loading',
  {
    progress: 0,
    step: ['Reaching out'],
    explanation: '',
    explanationOpacity: 1,
    srText: '',
    warning: null,
    phase: 'active',
  },
  // The typing loop writes every frame, and an unchanged frame notifies nobody.
  { equals: shallowEqual },
);

export const loadingStore: ReadableStore<LoadingState> = loading;
export const getLoadingState = loading.get;

/** Change some fields and keep the rest. */
export function updateLoading(patch: Partial<LoadingState>): void {
  loading.set({ ...loading.get(), ...patch });
}
