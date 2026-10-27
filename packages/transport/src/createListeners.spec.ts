// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createListeners } from './createListeners.js';

describe('createListeners', () => {
  it('As a provider, I deliver a message and each listener hears it in the order it subscribed', () => {
    // Given
    const listeners = createListeners();
    const heard: string[] = [];
    listeners.subscribe(message => heard.push(`first ${String(message[0])}`));
    listeners.subscribe(message => heard.push(`second ${String(message[0])}`));

    // When
    listeners.deliver(Uint8Array.of(7));

    // Then
    expect(heard).toEqual(['first 7', 'second 7']);
  });

  it('As a listener, I unsubscribe and hear no later message while the others still do', () => {
    // Given
    const listeners = createListeners();
    const heard: string[] = [];
    const unsubscribe = listeners.subscribe(() => heard.push('leaving'));
    listeners.subscribe(() => heard.push('staying'));

    // When
    unsubscribe();
    listeners.deliver(Uint8Array.of(1));

    // Then
    expect(heard).toEqual(['staying']);
  });

  it('As a listener, I dispose the provider while hearing a message and the listeners after me hear nothing', () => {
    // Given
    const listeners = createListeners();
    const heard: string[] = [];
    listeners.subscribe(() => {
      heard.push('disposing');
      listeners.dispose();
    });
    listeners.subscribe(() => heard.push('after'));

    // When
    listeners.deliver(Uint8Array.of(1));

    // Then
    expect(heard).toEqual(['disposing']);
  });

  it('As a provider, I dispose the listeners once and a later subscriber and message reach no one, and a second dispose returns false', () => {
    // Given
    const listeners = createListeners();
    const heard: string[] = [];
    listeners.subscribe(() => heard.push('before'));

    // When
    const first = listeners.dispose();
    const unsubscribeLate = listeners.subscribe(() => heard.push('late'));
    listeners.deliver(Uint8Array.of(1));
    unsubscribeLate();
    const second = listeners.dispose();

    // Then
    expect({ first, second, disposed: listeners.isDisposed(), heard }).toEqual({
      first: true,
      second: false,
      disposed: true,
      heard: [],
    });
  });

  it('As a provider, I read my listeners as not disposed before I dispose them', () => {
    // Given
    const listeners = createListeners();

    // When
    const disposed = listeners.isDisposed();

    // Then
    expect(disposed).toBe(false);
  });
});
