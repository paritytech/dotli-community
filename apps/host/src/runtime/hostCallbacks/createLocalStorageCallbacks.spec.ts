// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createMemoryStorage } from '@dotli/shared/testing';
import { yielded } from '../../testing/fixtures.js';
import { createLocalStorageCallbacks, type LocalStorageCallbacksParams } from './createLocalStorageCallbacks.js';

/** Hears that another tab changed a key. */
type StorageListener = (event: { key: string | null }) => void;

const KEY = 'truapi:product-storage:v1:9:myapp.dot:key';
const WATCHED = 'truapi:product-storage:v1:9:myapp.dot:watched';

let local: Storage;
let otherTabs: ReturnType<typeof createOtherTabs>;
let params: LocalStorageCallbacksParams;

describe('local-storage host callbacks', () => {
  beforeEach(() => {
    local = createMemoryStorage();
    otherTabs = createOtherTabs();
    params = { storage: () => local, events: () => otherTabs };
  });

  it('As a dotli integrator, I write product-scoped bytes and they are stored under the dotli prefix and read back', async () => {
    // Given
    const { read, write } = createLocalStorageCallbacks(params);

    // When
    await write(KEY, new Uint8Array([0, 1, 2, 253, 254, 255]));
    const readBack = await read(KEY);

    // Then
    expect(local.getItem(`dotli:${KEY}`)).toBe('AAEC/f7/');
    expect(Array.from(readBack ?? [])).toEqual([0, 1, 2, 253, 254, 255]);
  });

  it('As a dotli integrator, I clear stored bytes and a read finds nothing', async () => {
    // Given
    const { read, write, clear } = createLocalStorageCallbacks(params);
    await write(KEY, new Uint8Array([1]));

    // When
    await clear(KEY);
    const readBack = await read(KEY);

    // Then
    expect(readBack).toBeUndefined();
  });

  it('As a dotli integrator, I write a large value and it reads back intact', async () => {
    // Given
    const { read, write } = createLocalStorageCallbacks(params);
    const value = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256);

    // When
    await write('truapi:product-storage:v1:9:myapp.dot:large', value);
    const readBack = await read('truapi:product-storage:v1:9:myapp.dot:large');

    // Then
    expect(Array.from(readBack ?? [])).toEqual(Array.from(value));
  });

  it('As a product developer, I subscribe to a key and see the current value, then each write and clear', async () => {
    // Given
    const callbacks = createLocalStorageCallbacks(params);
    await callbacks.write(WATCHED, new Uint8Array([1]));
    const items = callbacks.subscribe(WATCHED)[Symbol.asyncIterator]();
    onTestFinished(async () => {
      await items.return?.();
    });

    // When
    const initial = await items.next();
    await callbacks.write(WATCHED, new Uint8Array([2, 3]));
    const written = await items.next();
    await callbacks.clear(WATCHED);
    const cleared = await items.next();

    // Then
    expect([initial, written, cleared].map(step => yielded(step)._unsafeUnwrap())).toEqual([
      { value: '0x01' },
      { value: '0x0203' },
      {},
    ]);
  });

  it('As a product developer, I subscribe to a key and ignore other keys while following other tabs', async () => {
    // Given
    const callbacks = createLocalStorageCallbacks(params);
    const items = callbacks.subscribe(WATCHED)[Symbol.asyncIterator]();
    onTestFinished(async () => {
      await items.return?.();
    });
    await items.next();

    // When
    await callbacks.write('truapi:product-storage:v1:9:myapp.dot:other', new Uint8Array([9]));
    local.setItem(`dotli:${WATCHED}`, 'BA==');
    otherTabs.send(`dotli:${WATCHED}`);
    const fromOtherTab = await items.next();

    // Then
    expect(yielded(fromOtherTab)._unsafeUnwrap()).toEqual({ value: '0x04' });
  });

  it('As a product developer whose storage the browser blocks, I subscribe and hear a read failure while the page records why', async () => {
    // Given
    const blocked = new DOMException('The operation is insecure.', 'SecurityError');
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const callbacks = createLocalStorageCallbacks({
      storage: () => {
        throw blocked;
      },
      events: () => otherTabs,
    });
    const items = callbacks.subscribe(WATCHED)[Symbol.asyncIterator]();
    onTestFinished(async () => {
      await items.return?.();
    });

    // When
    const first = await items.next();

    // Then
    expect(yielded(first)._unsafeUnwrapErr()).toEqual({ reason: 'Failed to read from storage' });
    expect(captures.expected).toHaveBeenCalledWith(blocked, { flow: 'storage', step: 'product_storage_watch' });
    expect(metrics.counted('product_storage.watch')).toEqual([{ outcome: 'error', reason: 'SecurityError' }]);
  });
});

/** Other tabs whose `storage` events the test sends by hand. Never throws. */
function createOtherTabs() {
  const listeners = new Set<StorageListener>();
  return {
    /** Adds `listener` for the events `send` delivers. */
    addEventListener(_type: 'storage', listener: StorageListener): void {
      listeners.add(listener);
    },
    /** Removes `listener`. */
    removeEventListener(_type: 'storage', listener: StorageListener): void {
      listeners.delete(listener);
    },
    /** Tells every listener that another tab changed `key`. */
    send(key: string | null): void {
      for (const listener of listeners) {
        listener({ key });
      }
    },
  };
}
