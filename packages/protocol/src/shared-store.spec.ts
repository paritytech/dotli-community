// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindLogSink, createStatusCell } from '@dotli/shared';
import type { ProtocolFrame, ProtocolStatus } from './frame.js';
import { createFrameRpc } from './rpc.js';
import { createSharedStore, type SharedAuthStorageChange, type SharedStoreStatus } from './shared-store.js';
import { createFakeFrame } from './frame.fake.js';

describe('createSharedStore', () => {
  it('As a returning user, my shared store connects until a first frame listens, then is down from each loss until a frame listens again', () => {
    // Given
    const fake = createFakeFrame();
    fake.setStatus('idle');
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc(fake.frame) });
    const statuses: SharedStoreStatus[] = [];
    store.subscribeSharedStoreStatus(status => statuses.push(status));
    const atStart = store.getSharedStoreStatus();

    // When: the first frame boots and listens, dies, is rebuilt, and is rebuilt again on purpose.
    for (const status of [
      'booting',
      'listening',
      'ready',
      'failed',
      'booting',
      'listening',
      'idle',
      'booting',
      'ready',
    ] as const) {
      fake.setStatus(status);
    }

    // Then
    expect(atStart).toBe('connecting');
    expect(statuses).toEqual(['available', 'unavailable', 'available', 'unavailable', 'available']);
  });

  it('As a dotli integrator, a frame status listener built before the shared store reads it available the moment the frame listens', () => {
    // Given a frame status listener registered before the shared store, which reads the store on each change
    const fake = createFakeFrame();
    fake.setStatus('idle');
    let store: ReturnType<typeof createSharedStore> | null = null;
    const read: (SharedStoreStatus | undefined)[] = [];
    fake.frame.subscribeStatus(() => {
      read.push(store?.getSharedStoreStatus());
    });
    store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc(fake.frame) });

    // When
    fake.setStatus('booting');
    fake.setStatus('listening');

    // Then
    expect(read).toEqual(['connecting', 'available']);
  });

  it('As a returning user, a frame status listener that rebuilds the frame as it listens leaves my shared store down until the new frame listens', () => {
    // Given a frame that publishes its status as the real one does, a listener first in line that rebuilds the frame
    // the first time it listens, and a shared store built after that listener
    const cell = createStatusCell<ProtocolStatus>('idle', {
      onListenerError: error => {
        throw error;
      },
    });
    const frame: ProtocolFrame = { ...createFakeFrame().frame, getStatus: cell.get, subscribeStatus: cell.subscribe };
    let rebuilt = false;
    cell.subscribe(next => {
      if (next === 'listening' && !rebuilt) {
        rebuilt = true;
        cell.set('idle');
        cell.set('booting');
      }
    });
    const store = createSharedStore({ frame, rpc: createFrameRpc(frame) });
    const statuses: SharedStoreStatus[] = [];
    store.subscribeSharedStoreStatus(status => statuses.push(status));

    // When the first frame listens and is rebuilt at once
    cell.set('booting');
    cell.set('listening');

    // Then the store reads down while the new frame boots, not still connecting
    expect(store.getSharedStoreStatus()).toBe('unavailable');

    // When the new frame listens
    cell.set('listening');

    // Then the store is available again
    expect(store.getSharedStoreStatus()).toBe('available');
    expect(statuses).toEqual(['unavailable', 'available']);
  });

  it("As a returning user, another tab's shared auth write reaches me, and my subscription waits only for a listening frame", async () => {
    // Given a frame still booting, and a subscription made while it boots
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const warnings: string[] = [];
    onTestFinished(
      bindLogSink({
        emit: (level, message) => {
          if (level === 'warn') {
            warnings.push(message);
          }
        },
      }),
    );
    const fake = createFakeFrame();
    fake.setStatus('booting');
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc(fake.frame) });
    const changes: SharedAuthStorageChange[] = [];
    store.subscribeSharedAuthStorage(change => changes.push(change));

    // When the frame listens, a sibling tab writes, and the frame is dropped before it is ready
    fake.setStatus('listening');
    fake.send({ namespace: 'dotli:protocol', kind: 'auth-storage-changed', siteId: 'dotli', key: 'k', value: 'v' });
    fake.setStatus('idle');
    await vi.advanceTimersByTimeAsync(0);

    // Then the write reached me, and the listening frame met the subscription's wait, so the drop is no failure
    expect(changes).toEqual([{ siteId: 'dotli', key: 'k', value: 'v' }]);
    expect(warnings).toEqual([]);
  });
});
