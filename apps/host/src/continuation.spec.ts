// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { safeStorage } from '@dotli/shared';
import { memoryStorage } from '@dotli/shared/testing';
import { markContinuation, peekContinuation, takeContinuation, type ContinuationStore } from './continuation.js';

function unavailableStore(): ContinuationStore {
  return safeStorage(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
}

describe('continuation', () => {
  it('As a reloaded tab, I read why the app reloaded me once, and the load after reads no reason', () => {
    // Given
    const store = memoryStorage();
    markContinuation('settings_change', store);

    // When
    const first = takeContinuation(store);
    const second = takeContinuation(store);

    // Then
    expect(first).toBe('settings_change');
    expect(second).toBeNull();
    expect(store.length).toBe(0);
  });

  it('As the leaving page, I peek at the reason and leave it for the next load', () => {
    // Given
    const store = memoryStorage();
    markContinuation('reload_button', store);

    // When
    const peeked = peekContinuation(store);

    // Then
    expect(peeked).toBe('reload_button');
    expect(takeContinuation(store)).toBe('reload_button');
  });

  it('As a tab holding a reason this build does not know, I read no reason and clear it', () => {
    // Given
    const store = memoryStorage({ 'dotli:continuation': 'from_a_newer_build' });

    // When
    const taken = takeContinuation(store);

    // Then
    expect(taken).toBeNull();
    expect(store.length).toBe(0);
  });

  it('As a tab without sessionStorage, marking is silent and the next load reads a plain reload', () => {
    // Given
    const store = unavailableStore();

    // When
    markContinuation('app_update', store);

    // Then
    expect(peekContinuation(store)).toBeNull();
    expect(takeContinuation(store)).toBeNull();
  });
});
