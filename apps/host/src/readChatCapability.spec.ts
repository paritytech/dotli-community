// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@dotli/shared';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createStorageCapabilityCache, readChatCapability, type CapabilityCache } from './readChatCapability.js';
import { bindReports } from './testing/bindReports.js';
import { createBlockedStorage } from './testing/createBlockedStorage.js';

type Params = {
  /** The entries the page's storage holds before the load, none by default. */
  seed?: Record<string, string>;
};

describe('chat capability', () => {
  it('As a visitor on a product that declares chat, I load it and the manifest answers and is kept for the next load', async () => {
    // Given
    const { stored, cache } = createPage();

    // When
    const chat = await readChatCapability('myapp', () => Promise.resolve(true), { cache });

    // Then
    expect(chat).toBe(true);
    expect(stored.getItem('dotli:chat-capable:myapp')).toBe('1');
  });

  it('As a returning visitor, I load my product and it answers from the cache without waiting on the manifest read', async () => {
    // Given
    const { cache } = createPage({ seed: { 'dotli:chat-capable:myapp': '1' } });
    const read = vi.fn(() => new Promise<boolean>(() => undefined));

    // When
    const chat = await readChatCapability('myapp', read, { cache });

    // Then
    expect(chat).toBe(true);
    expect(read).toHaveBeenCalledOnce();
  });

  it('As a returning visitor whose product dropped chat, I load it and this load keeps the cached answer while the next load gets the new one', async () => {
    // Given
    const { stored, cache } = createPage({ seed: { 'dotli:chat-capable:myapp': '1' } });
    const read = createDeferred<boolean>();

    // When
    const chat = await readChatCapability('myapp', () => read.promise, { cache });
    read.resolve(false);
    await read.promise;

    // Then
    expect(chat).toBe(true);
    expect(stored.getItem('dotli:chat-capable:myapp')).toBe('0');
  });

  it('As a visitor whose worker manifest cannot be read, I load my product and it gets no chat this load while the cache keeps its answer', async () => {
    // Given
    const { stored, cache } = createPage();

    // When
    const chat = await readChatCapability('myapp', () => Promise.reject(new Error('offline')), { cache });

    // Then
    expect(chat).toBe(false);
    expect(stored.getItem('dotli:chat-capable:myapp')).toBeNull();
  });

  it('As an operator, I see a worker manifest that cannot be read captured and counted under the chat capability metric', async () => {
    // Given a manifest read that rejects
    const { captures, counted } = bindReports();
    const { cache } = createPage();
    const failure = new TypeError('offline');

    // When the capability is read
    await readChatCapability('myapp', () => Promise.reject(failure), { cache });

    // Then the failure is captured once and counted with its class name
    expect({ captured: captures.exception.mock.calls, counted: counted('chat.capability') }).toMatchObject({
      captured: [[failure, { step: 'capability_read' }]],
      counted: [{ outcome: 'error', reason: 'TypeError' }],
    });
  });

  it('As a visitor whose browser blocks storage, I load my product and it still answers from its manifest', async () => {
    // Given
    const cache = createStorageCapabilityCache({ storage: createBlockedStorage() });

    // When
    const chat = await readChatCapability('myapp', () => Promise.resolve(true), { cache });

    // Then
    expect(chat).toBe(true);
  });
});

/** Returns a page load whose storage holds `seed`, and what it stores. */
function createPage({ seed = {} }: Params = {}): { stored: Storage; cache: CapabilityCache } {
  const stored = createMemoryStorage({ entries: seed });
  return { stored, cache: createStorageCapabilityCache({ storage: stored }) };
}
