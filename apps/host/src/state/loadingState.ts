// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, isShallowEqual, type ReadableStore } from '@dotli/shared';

/** `gone` is terminal: no phase follows it. */
export type LoadingScreenPhase = 'active' | 'dismissing' | 'gone';

/** A piece of the step line. The name being loaded is drawn with its TLD dimmed. */
export type StepPart = string | { host: string; tld: string };

/** What the loading screen draws. */
export type LoadingState = {
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
};

const loading = createSyncStore<LoadingState>({
  name: 'loading',
  initial: {
    progress: 0,
    step: ['Reaching out'],
    explanation: '',
    explanationOpacity: 1,
    srText: '',
    warning: null,
    phase: 'active',
  },
  // A write can come every frame, and an unchanged frame notifies nobody.
  equals: isShallowEqual,
});
const store: ReadableStore<LoadingState> = loading;

/** The loading screen's progress, step line, explanation and phase. */
export const loadingState = {
  /** What the loading screen draws. Notifies only when a field changes. */
  store,
  /** Returns the current state. Never throws. */
  get,
  /** Writes `patch` over the current state, keeping the fields it leaves out. Never throws. */
  update,
};

function get(): LoadingState {
  return loading.get();
}

function update(patch: Partial<LoadingState>): void {
  loading.set({ ...loading.get(), ...patch });
}
