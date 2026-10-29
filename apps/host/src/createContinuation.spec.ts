// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createContinuation } from './createContinuation.js';
import { createBlockedStorage } from './testing/createBlockedStorage.js';

describe('createContinuation', () => {
  it('As a user whose tab the app reloaded, I load twice and the first load reads why once while the next reads no reason', () => {
    // Given
    const store = createMemoryStorage();
    const continuation = createContinuation({ store });
    continuation.mark('settings_change');

    // When
    const reasons = [continuation.take(), continuation.take()];

    // Then
    expect({ reasons, stored: store.length }).toEqual({ reasons: ['settings_change', null], stored: 0 });
  });

  it('As a user leaving a page, I peek at the reason and it stays for the next load', () => {
    // Given
    const continuation = createContinuation({ store: createMemoryStorage() });
    continuation.mark('reload_button');

    // When
    const peeked = continuation.peek();
    const taken = continuation.take();

    // Then
    expect({ peeked, taken }).toEqual({ peeked: 'reload_button', taken: 'reload_button' });
  });

  it('As a user whose tab holds a reason this build does not know, I load and read no reason while it is cleared', () => {
    // Given
    const store = createMemoryStorage({ entries: { 'dotli:continuation': 'from_a_newer_build' } });
    const continuation = createContinuation({ store });

    // When
    const taken = continuation.take();

    // Then
    expect({ taken, stored: store.length }).toEqual({ taken: null, stored: 0 });
  });

  it('As a user whose tab has no sessionStorage, I mark a reload and the next load reads a plain reload', () => {
    // Given
    const continuation = createContinuation({ store: createBlockedStorage() });

    // When
    continuation.mark('app_update');
    const answers = { peeked: continuation.peek(), taken: continuation.take() };

    // Then
    expect(answers).toEqual({ peeked: null, taken: null });
  });
});
