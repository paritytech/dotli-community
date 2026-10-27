// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { catchError } from '@dotli/shared/testing';
import { createProviderPair } from './provider.fake.js';
import { matchInstance } from './testing/matchers.js';

describe('createProviderPair', () => {
  it('As a test, I post a buffer again and see it fail as in a browser', () => {
    // Given
    const { left } = createProviderPair();
    const data = new Uint8Array(8);
    left.postMessage(data);

    // When
    const thrown = catchError(() => {
      left.postMessage(data);
    });

    // Then
    expect(thrown).toEqual(matchInstance(Error));
  });

  it('As a test, I have a listener dispose its side and the message stops reaching the others', async () => {
    // Given
    const { left, right } = createProviderPair();
    const sibling = vi.fn();
    const disposed = new Promise<void>(resolve => {
      right.subscribe(() => {
        right.dispose();
        resolve();
      });
    });
    right.subscribe(sibling);

    // When
    left.postMessage(new Uint8Array(1));
    await disposed;

    // Then
    expect(sibling).not.toHaveBeenCalled();
  });

  it('As a test, I close a side and a message it posted before still arrives, and nothing reaches it', async () => {
    // Given
    const { left, right } = createProviderPair();
    const heard = vi.fn();
    const arrived = new Promise<Uint8Array>(resolve => right.subscribe(resolve));
    right.postMessage(new Uint8Array(1));
    left.postMessage(new Uint8Array(2));

    // When
    left.dispose();
    left.subscribe(heard);
    const message = await arrived;

    // Then left's message arriving means right's earlier one has already reached the closed left
    expect(message.byteLength).toBe(2);
    expect(heard).not.toHaveBeenCalled();
  });

  it('As a test, I post bytes and get them in order on a microtask, in a correct environment', async () => {
    // Given
    const { left, right, delivered } = createProviderPair();
    const heard: number[] = [];
    right.subscribe(message => heard.push(message.byteLength));

    // When
    left.postMessage(new Uint8Array(1));
    left.postMessage(new Uint8Array(2));
    const heardAtOnce = [...heard];
    await Promise.resolve();

    // Then
    expect(heardAtOnce).toEqual([]);
    expect(heard).toEqual([1, 2]);
    expect(delivered).toHaveLength(2);
    expect([left.isCorrectEnvironment(), right.isCorrectEnvironment()]).toEqual([true, true]);
  });
});
