// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { recordNotified } from '../../../testing/recordNotified.js';
import { loadingState } from './loadingState.js';

afterEach(() => {
  resetAllStoresForTests();
});

describe('loading store', () => {
  it('As a user watching the loading screen, I get the same explanation frame again and it redraws only once it types on', () => {
    // Given
    loadingState.update({ explanation: 'Reach' });
    const notified = recordNotified(loadingState.store);

    // When: the typing loop writes the same frame again, twice, then types on.
    loadingState.update({ explanation: 'Reach' });
    loadingState.update({ ...loadingState.get() });
    loadingState.update({ explanation: 'Reaching out' });

    // Then
    expect(notified).toEqual([{ ...loadingState.store.init, explanation: 'Reaching out' }]);
  });
});
