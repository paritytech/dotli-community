// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindLogSink } from '@dotli/shared';
import { createChatCapability, storageCapabilityCache, type ChatCapability } from './chat-capability.js';

describe('chat capability', () => {
  let stored: Map<string, string>;
  let capability: ChatCapability;

  /** The next answer announced for `label`. */
  function nextAnswer(label: string): Promise<boolean> {
    return new Promise(resolve => {
      const stop = capability.subscribe(label, chat => {
        stop();
        resolve(chat);
      });
    });
  }

  /** A fresh page load whose storage holds `seed`. */
  function load(seed: Record<string, string> = {}): void {
    stored = new Map(Object.entries(seed));
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    };
    capability = createChatCapability(storageCapabilityCache(() => storage));
  }

  beforeEach(() => {
    load();
  });

  it('As the bridge, I ask for an unprimed label and get no chat', async () => {
    // When / Then
    expect(await capability.capabilityFor('unknown')).toBe(false);
  });

  it('As the bridge, I prime a label and it resolves from the manifest and announces', async () => {
    // Given
    const announced = nextAnswer('myapp');

    // When
    capability.prime('myapp', () => Promise.resolve(true));

    // Then
    expect(await capability.capabilityFor('myapp')).toBe(true);
    expect(await announced).toBe(true);
    expect(await capability.capabilityFor('other')).toBe(false);
  });

  it('As the bridge, I prime a cached label and get the answer without waiting on the resolver', async () => {
    // Given
    load({ 'dotli:chat-capable:myapp': '1' });
    const resolver = vi.fn(() => new Promise<boolean>(() => undefined));

    // When
    capability.prime('myapp', resolver);

    // Then
    expect(await capability.capabilityFor('myapp')).toBe(true);
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('As the bridge, I prime a label and a fresh resolve updates the cache for the next load', async () => {
    // Given
    const announced = nextAnswer('myapp');

    // When
    capability.prime('myapp', () => Promise.resolve(true));
    await announced;

    // Then
    expect(stored.get('dotli:chat-capable:myapp')).toBe('1');
  });

  it('As the bridge, I prime a label whose resolve fails and get the cached value', async () => {
    // Given
    load({ 'dotli:chat-capable:myapp': '1' });
    const answers: boolean[] = [];
    const twoAnswers = new Promise<void>(resolve => {
      capability.subscribe('myapp', chat => {
        if (answers.push(chat) === 2) {
          resolve();
        }
      });
    });

    // When
    capability.prime('myapp', () => Promise.reject(new Error('offline')));

    // Then
    expect(await capability.capabilityFor('myapp')).toBe(true);
    await twoAnswers;
    expect(answers).toEqual([true, true]);
    expect(stored.get('dotli:chat-capable:myapp')).toBe('1');
  });

  it('As the debug path, I force a capability and it answers immediately', async () => {
    // When
    capability.set('localhost:5173', true);

    // Then
    expect(await capability.capabilityFor('localhost:5173')).toBe(true);
  });

  it('As the chat panel, I subscribe after the answer settled and hear it at once', () => {
    // Given
    capability.set('myapp', true);
    const answers: boolean[] = [];

    // When
    capability.subscribe('myapp', chat => answers.push(chat));

    // Then
    expect(answers).toEqual([true]);
  });

  it("As the chat panel, I hear only my product's answers, until I unsubscribe", () => {
    // Given
    const answers: boolean[] = [];
    const stop = capability.subscribe('myapp', chat => answers.push(chat));

    // When
    capability.set('other', true);
    capability.set('myapp', false);
    stop();
    capability.set('myapp', true);

    // Then
    expect(answers).toEqual([false]);
  });

  it('As the bridge, I get my answer even when a subscriber throws', async () => {
    // Given
    const heard: boolean[] = [];
    const logged: string[] = [];
    bindLogSink({ emit: (level, message) => logged.push(`${level} ${message}`) });
    capability.subscribe('myapp', () => {
      throw new Error('broken panel');
    });
    capability.subscribe('myapp', chat => heard.push(chat));

    // When
    capability.prime('myapp', () => Promise.resolve(true));

    // Then
    expect(await capability.capabilityFor('myapp')).toBe(true);
    expect(heard).toEqual([true]);
    expect(logged).toEqual(['error [dot.li chat] a chat capability subscriber failed: broken panel']);
  });
});
