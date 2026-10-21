// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { getLoadingState, loadingStore, updateLoading } from './loading.js';

afterEach(() => {
  resetAllStoresForTests();
});

describe('loading store', () => {
  it('As the loading screen, a frame that rewrites the same explanation notifies nobody', () => {
    // Given
    updateLoading({ explanation: 'Reaching out', explanationOpacity: 0.5 });
    let notified = 0;
    const stop = loadingStore.subscribe(() => {
      notified += 1;
    });

    // When: the typing loop writes the same frame again, twice.
    updateLoading({ explanation: 'Reaching out', explanationOpacity: 0.5 });
    updateLoading({ ...getLoadingState() });

    // Then
    expect(notified).toBe(0);

    // When
    updateLoading({ explanationOpacity: 1 });

    // Then
    expect(notified).toBe(1);
    stop();
  });
});
