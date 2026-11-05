// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { atom } from 'nanostores';
import { describe, expect, it } from 'vitest';
import { holdNetworkWhileLoading } from './holdNetworkWhileLoading.js';
import type { LoadingScreenPhase, LoadingState } from './state/loadingState.js';

function createLoading(phase: LoadingScreenPhase) {
  return atom<LoadingState>({
    progress: 0,
    step: [],
    explanation: '',
    explanationOpacity: 1,
    srText: '',
    warning: null,
    phase,
  });
}

/** A pause that counts its open holds. Each release acts once, as the real one does. */
function createFakePause() {
  let open = 0;
  return {
    countOpen: () => open,
    hold() {
      open += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          open -= 1;
        }
      };
    },
  };
}

describe('holdNetworkWhileLoading', () => {
  it('As a product page that loads, my network stays held until the loading screen is gone', () => {
    // Given
    const pause = createFakePause();
    const loading = createLoading('active');
    const opened: number[] = [];

    // When
    holdNetworkWhileLoading({ pause, loading });
    opened.push(pause.countOpen());
    loading.set({ ...loading.get(), phase: 'dismissing' });
    opened.push(pause.countOpen());
    loading.set({ ...loading.get(), phase: 'gone' });
    opened.push(pause.countOpen());

    // Then
    expect(opened).toEqual([1, 1, 0]);
  });

  it('As a product page whose load already ended, I hold nothing', () => {
    // Given
    const pause = createFakePause();
    const loading = createLoading('gone');

    // When
    holdNetworkWhileLoading({ pause, loading });

    // Then
    expect(pause.countOpen()).toBe(0);
  });

  it('As a product page that stops early, my hold is released', () => {
    // Given
    const pause = createFakePause();
    const loading = createLoading('active');
    const stop = holdNetworkWhileLoading({ pause, loading });

    // When
    stop();

    // Then
    expect(pause.countOpen()).toBe(0);
  });
});
