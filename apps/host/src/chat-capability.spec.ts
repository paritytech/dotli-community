// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { safeStorage } from '@dotli/shared';
import { memoryStorage } from '@dotli/shared/testing';
import { readChatCapability, storageCapabilityCache, type CapabilityCache } from './chat-capability.js';

/** A page load whose storage holds `seed`, and what it stores. */
function page(seed: Record<string, string> = {}): { stored: Storage; cache: CapabilityCache } {
  const stored = memoryStorage(seed);
  return { stored, cache: storageCapabilityCache(stored) };
}

describe('chat capability', () => {
  it('As a product that declares chat, my first load answers from the manifest and keeps it for the next', async () => {
    // Given
    const { stored, cache } = page();

    // When
    const chat = await readChatCapability('myapp', () => Promise.resolve(true), cache);

    // Then
    expect(chat).toBe(true);
    expect(stored.getItem('dotli:chat-capable:myapp')).toBe('1');
  });

  it('As a returning visitor, my product answers from the cache without waiting on the manifest read', async () => {
    // Given
    const { cache } = page({ 'dotli:chat-capable:myapp': '1' });
    const read = vi.fn(() => new Promise<boolean>(() => undefined));

    // When
    const chat = await readChatCapability('myapp', read, cache);

    // Then
    expect(chat).toBe(true);
    expect(read).toHaveBeenCalledOnce();
  });

  it('As a returning visitor whose product dropped chat, this load keeps the cached answer and the next load gets the new one', async () => {
    // Given
    const { stored, cache } = page({ 'dotli:chat-capable:myapp': '1' });
    let answer: (chat: boolean) => void = () => undefined;
    const read = new Promise<boolean>(resolve => {
      answer = resolve;
    });

    // When
    const chat = await readChatCapability('myapp', () => read, cache);
    answer(false);
    await read;

    // Then
    expect(chat).toBe(true);
    expect(stored.getItem('dotli:chat-capable:myapp')).toBe('0');
  });

  it('As a visitor whose worker manifest cannot be read, my product gets no chat this load and the cache keeps its answer', async () => {
    // Given
    const { stored, cache } = page();

    // When
    const chat = await readChatCapability('myapp', () => Promise.reject(new Error('offline')), cache);

    // Then
    expect(chat).toBe(false);
    expect(stored.getItem('dotli:chat-capable:myapp')).toBeNull();
  });

  it('As a visitor whose browser blocks storage, my product still answers from its manifest', async () => {
    // Given
    const cache = storageCapabilityCache(
      safeStorage(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      }),
    );

    // When
    const chat = await readChatCapability('myapp', () => Promise.resolve(true), cache);

    // Then
    expect(chat).toBe(true);
  });
});
