// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import {
  pillShield,
  setVerificationShieldState,
  showLocalhostPill,
  showProductPill,
  urlPillStore,
} from './url-pill.js';

afterEach(() => {
  resetAllStoresForTests();
});

describe('url pill store', () => {
  it('As the URL pill, the shield shows only for a product, with no state until the host knows', () => {
    // Then, before any product
    expect(pillShield(urlPillStore.get())).toBeUndefined();

    // When
    showLocalhostPill('localhost:3000');

    // Then
    expect(pillShield(urlPillStore.get())).toBeUndefined();

    // When
    showProductPill('app', '.dot.li');

    // Then
    expect(pillShield(urlPillStore.get())).toBeNull();

    // When
    setVerificationShieldState('trusted');

    // Then
    expect(pillShield(urlPillStore.get())).toBe('trusted');
  });

  it('As the URL pill, showing the same pill or shield again notifies nobody', () => {
    // Given
    showProductPill('app', '.dot');
    setVerificationShieldState('verified');
    let notified = 0;
    const stop = urlPillStore.subscribe(() => {
      notified += 1;
    });

    // When
    setVerificationShieldState('verified');

    // Then
    expect(notified).toBe(0);

    // When
    showLocalhostPill('localhost:3000');
    showLocalhostPill('localhost:3000');

    // Then
    expect(notified).toBe(1);
    stop();
  });
});
