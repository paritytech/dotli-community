// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createListenerSet } from './listener-set.js';

describe('createListenerSet', () => {
  it('As a layer above, I hear each value in order, and a listener that throws is reported while the next still hears it', () => {
    // Given
    const errors: [unknown, number][] = [];
    const listeners = createListenerSet<number>({ onListenerError: (error, value) => errors.push([error, value]) });
    const broken = new TypeError('listener broke');
    listeners.subscribe(() => {
      throw broken;
    });
    const heard: number[] = [];
    listeners.subscribe(value => heard.push(value));

    // When
    listeners.emit(1);
    listeners.emit(2);

    // Then
    expect(heard).toEqual([1, 2]);
    expect(errors).toEqual([
      [broken, 1],
      [broken, 2],
    ]);
  });

  it('As a listener that emits while it hears a value, my value waits for the round in progress', () => {
    // Given
    const listeners = createListenerSet<string>({ onListenerError: () => undefined });
    const heard: string[] = [];
    listeners.subscribe(value => {
      heard.push(`first:${value}`);
      if (value === 'a') {
        listeners.emit('b');
      }
    });
    listeners.subscribe(value => heard.push(`second:${value}`));

    // When
    listeners.emit('a');

    // Then
    expect(heard).toEqual(['first:a', 'second:a', 'first:b', 'second:b']);
  });

  it('As a subscriber who subscribed twice, I am two subscriptions, and each unsubscribe ends one of them once', () => {
    // Given
    const listeners = createListenerSet<number>({ onListenerError: () => undefined });
    let heard = 0;
    const listener = (): void => {
      heard += 1;
    };
    const first = listeners.subscribe(listener);
    listeners.subscribe(listener);

    // When
    first();
    first();
    listeners.emit(1);

    // Then
    expect(heard).toBe(1);
    expect(listeners.size).toBe(1);
  });

  it('As a late subscriber, a replay delivered to me alone is reported like any other throw', () => {
    // Given
    const errors: number[] = [];
    const listeners = createListenerSet<number>({ onListenerError: (_error, value) => errors.push(value) });
    const heard: number[] = [];
    listeners.subscribe(value => heard.push(value));

    // When
    listeners.deliver(() => {
      throw new Error('late listener broke');
    }, 7);

    // Then
    expect(errors).toEqual([7]);
    expect(heard).toEqual([]);
  });
});
