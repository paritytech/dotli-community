// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { recordNotified } from '../testing/recordNotified.js';
import { loadingState } from './loadingState.js';

afterEach(() => {
  resetAllStoresForTests();
});

describe('loading store', () => {
  it('As a user watching the loading screen, I get the same explanation frame again and it redraws only once it stops dimming', () => {
    // Given
    loadingState.update({ explanation: 'Reaching out', explanationOpacity: 0.5 });
    const notified = recordNotified(loadingState.store);

    // When: the typing loop writes the same frame again, twice, then dims no more.
    loadingState.update({ explanation: 'Reaching out', explanationOpacity: 0.5 });
    loadingState.update({ ...loadingState.get() });
    loadingState.update({ explanationOpacity: 1 });

    // Then
    expect(notified).toEqual([{ ...loadingState.store.init, explanation: 'Reaching out', explanationOpacity: 1 }]);
  });
});
