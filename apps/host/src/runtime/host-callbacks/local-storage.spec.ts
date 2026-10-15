// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { memoryStorage } from '@dotli/shared/testing';
import { yielded } from '../../testing/fixtures.js';
import * as page from './local-storage.js';

let local: Storage;
let otherTabs: EventTarget;
let deps: page.ProductStorageDeps;

const createLocalStorageRead = (): ReturnType<typeof page.createLocalStorageRead> => page.createLocalStorageRead(deps);
const createLocalStorageWrite = (): ReturnType<typeof page.createLocalStorageWrite> =>
  page.createLocalStorageWrite(deps);
const createLocalStorageClear = (): ReturnType<typeof page.createLocalStorageClear> =>
  page.createLocalStorageClear(deps);
const createLocalStorageSubscribe = (): ReturnType<typeof page.createLocalStorageSubscribe> =>
  page.createLocalStorageSubscribe(deps);

describe('local-storage host callbacks', () => {
  beforeEach(() => {
    local = memoryStorage();
    otherTabs = new EventTarget();
    deps = { storage: () => local, events: () => otherTabs };
  });

  it('As a dotli integrator, the host round-trips product-scoped bytes', async () => {
    // Given
    const read = createLocalStorageRead();
    const write = createLocalStorageWrite();
    const clear = createLocalStorageClear();

    // When
    await write('truapi:product-storage:v1:9:myapp.dot:key', new Uint8Array([0, 1, 2, 253, 254, 255]));

    // Then
    expect(local.getItem('dotli:truapi:product-storage:v1:9:myapp.dot:key')).toBe('AAEC/f7/');
    expect(Array.from((await read('truapi:product-storage:v1:9:myapp.dot:key')) ?? [])).toEqual([
      0, 1, 2, 253, 254, 255,
    ]);

    await clear('truapi:product-storage:v1:9:myapp.dot:key');
    expect(await read('truapi:product-storage:v1:9:myapp.dot:key')).toBeUndefined();
  });

  it('As a dotli integrator, a large value round-trips intact', async () => {
    // Given
    const read = createLocalStorageRead();
    const write = createLocalStorageWrite();
    const value = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256);

    // When
    await write('truapi:product-storage:v1:9:myapp.dot:large', value);

    // Then
    expect(Array.from((await read('truapi:product-storage:v1:9:myapp.dot:large')) ?? [])).toEqual(Array.from(value));
  });

  it('As a product, my storage subscription sees the current value, then each write and clear', async () => {
    // Given
    const key = 'truapi:product-storage:v1:9:myapp.dot:watched';
    await createLocalStorageWrite()(key, new Uint8Array([1]));
    const items = createLocalStorageSubscribe()(key)[Symbol.asyncIterator]();

    // When
    const initial = await items.next();
    await createLocalStorageWrite()(key, new Uint8Array([2, 3]));
    const written = await items.next();
    await createLocalStorageClear()(key);
    const cleared = await items.next();
    await items.return?.();

    // Then
    expect(yielded(initial)._unsafeUnwrap()).toEqual({ value: '0x01' });
    expect(yielded(written)._unsafeUnwrap()).toEqual({ value: '0x0203' });
    expect(yielded(cleared)._unsafeUnwrap()).toEqual({});
  });

  it('As a product, my storage subscription ignores other keys and follows other tabs', async () => {
    // Given
    const key = 'truapi:product-storage:v1:9:myapp.dot:watched';
    const items = createLocalStorageSubscribe()(key)[Symbol.asyncIterator]();
    await items.next();

    // When
    await createLocalStorageWrite()('truapi:product-storage:v1:9:myapp.dot:other', new Uint8Array([9]));
    local.setItem(`dotli:${key}`, 'BA==');
    otherTabs.dispatchEvent(Object.assign(new Event('storage'), { key: `dotli:${key}` }));
    const fromOtherTab = await items.next();
    await items.return?.();

    // Then
    expect(yielded(fromOtherTab)._unsafeUnwrap()).toEqual({ value: '0x04' });
  });

  it('As a product whose storage the browser blocks, my subscription hears a read failure and the page records why', async () => {
    // Given
    const blocked = new DOMException('The operation is insecure.', 'SecurityError');
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    deps = {
      storage: () => {
        throw blocked;
      },
      events: () => otherTabs,
    };

    // When
    const items = createLocalStorageSubscribe()('truapi:product-storage:v1:9:myapp.dot:watched')[
      Symbol.asyncIterator
    ]();
    const first = await items.next();
    await items.return?.();

    // Then
    expect(yielded(first)._unsafeUnwrapErr()).toEqual({ reason: 'Failed to read from storage' });
    expect(captures.expected).toHaveBeenCalledWith(blocked, { flow: 'storage', step: 'product_storage_watch' });
    expect(metrics.counted('product_storage.watch')).toEqual([{ outcome: 'error', reason: 'SecurityError' }]);
  });
});
