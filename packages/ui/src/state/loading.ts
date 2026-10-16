// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, shallowEqual, type ReadableStore } from './create-store.js';

/** `gone` is terminal: the controller starts no timer once it is reached. */
export type LoadingScreenPhase = 'active' | 'dismissing' | 'gone';

/** A piece of the step line. The name being loaded is drawn with its TLD dimmed. */
export type StepPart = string | { host: string; tld: string };

/** Written only by `loading-controller.ts`. */
export interface LoadingState {
  /** 0 to 100, fractional. The shown number is rounded. */
  progress: number;
  /** The running stage's opening sentence. */
  step: readonly StepPart[];
  /** Part-typed while it turns over. */
  explanation: string;
  /** Dims while the explanation turns over. */
  explanationOpacity: number;
  /** The whole sentence, set once per line. */
  srText: string;
  /** The stall warning under the bar. */
  warning: string | null;
  phase: LoadingScreenPhase;
}

// Matches the host page's build-time render, which paints first.
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

export function updateLoading(patch: Partial<LoadingState>): void {
  loading.set({ ...loading.get(), ...patch });
}
