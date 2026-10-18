// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { bindLogSink, createStatusCell } from '@dotli/shared';
import { manualTimers } from '@dotli/shared/testing';
import { hostFailure, ok, type Sink } from '@dotli/transport';
import type { ProtocolFrame, ProtocolStatus } from './frame.js';
import { createFrameRpc } from './rpc.js';
import { createSharedStore, type SharedAuthStorageChange, type SharedStoreStatus } from './shared-store.js';
import { createFakeFrame } from './frame.fake.js';
import type { ProtocolTransport } from './schema.js';

type ChangeSink = Sink<SharedAuthStorageChange, never>;

/** A frame app that relays sibling tabs' auth changes, keeping each subscriber's sink while it is subscribed. */
function relayingChanges(sinks: Set<ChangeSink>): (serving: ProtocolTransport) => void {
  return serving => {
    serving.handleSubscription('storage', 'authChanges', (_start, _context, sink) => {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    });
  };
}

/** A frame app that keeps the sink of every auth change subscription it was asked for, in order. */
function openingChanges(opened: ChangeSink[]): (serving: ProtocolTransport) => void {
  return serving => {
    serving.handleSubscription('storage', 'authChanges', (_start, _context, sink) => {
      opened.push(sink);
      return () => undefined;
    });
  };
}

/** The `log.error` messages of this test. */
function recordLoggedErrors(): string[] {
  const errors: string[] = [];
  onTestFinished(
    bindLogSink({
      emit: (level, message) => {
        if (level === 'error') {
          errors.push(message);
        }
      },
    }),
  );
  return errors;
}

describe('createSharedStore', () => {
  it('As a returning user, my shared store connects until a first frame listens, then is down from each loss until a frame listens again', () => {
    // Given
    const fake = createFakeFrame(undefined, { status: 'idle' });
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
    const fake = createFakeFrame(undefined, { status: 'idle' });
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
    const timers = manualTimers();
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
    const sinks = new Set<ChangeSink>();
    const fake = createFakeFrame(relayingChanges(sinks), { status: 'booting', timers });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc(fake.frame, timers) });
    const changes: SharedAuthStorageChange[] = [];
    store.subscribeSharedAuthStorage(change => changes.push(change));
    await timers.advance(0);
    const subscribedWhileBooting = sinks.size;

    // When the frame listens, a sibling tab writes, and the frame is dropped before it is ready
    fake.setStatus('listening');
    await timers.advance(0);
    for (const sink of sinks) {
      sink.receive({ siteId: 'dotli', key: 'k', value: 'v' });
    }
    await timers.advance(0);
    fake.setStatus('idle');
    await timers.advance(0);

    // Then the write reached me, and the listening frame met the subscription's wait, so the drop is no failure
    expect(subscribedWhileBooting).toBe(0);
    expect(changes).toEqual([{ siteId: 'dotli', key: 'k', value: 'v' }]);
    expect(warnings).toEqual([]);
  });

  it('As a returning user, my shared auth subscription follows each new frame and stops in the frame once I leave', async () => {
    // Given a subscription on a frame that is then lost and rebuilt
    const timers = manualTimers();
    const sinks = new Set<ChangeSink>();
    const fake = createFakeFrame(relayingChanges(sinks), { timers });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc(fake.frame, timers) });
    const changes: SharedAuthStorageChange[] = [];
    const unsubscribe = store.subscribeSharedAuthStorage(change => changes.push(change));
    await timers.advance(0);
    fake.lose(new Error('boom'));
    fake.setStatus('booting');
    fake.setStatus('listening');
    await timers.advance(0);
    const subscribedOnRebuilt = sinks.size;

    // When a sibling tab writes, and then I leave
    for (const sink of sinks) {
      sink.receive({ siteId: 'dotli', key: 'k', value: null });
    }
    await timers.advance(0);
    unsubscribe();
    await timers.advance(0);

    // Then
    expect(subscribedOnRebuilt).toBe(1);
    expect(changes).toEqual([{ siteId: 'dotli', key: 'k', value: null }]);
    expect(sinks.size).toBe(0);
  });

  it('As a returning user, my shared auth subscription the frame ends while it stays up is reopened after a wait that doubles, and each end is reported and captured once', async () => {
    // Given a subscription on a frame that stays up
    const timers = manualTimers();
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordCaptures({ onFinished: onTestFinished });
    const errors = recordLoggedErrors();
    const opened: ChangeSink[] = [];
    const fake = createFakeFrame(openingChanges(opened), { timers });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc(fake.frame, timers), timers });
    const changes: SharedAuthStorageChange[] = [];
    store.subscribeSharedAuthStorage(change => changes.push(change));
    await timers.advance(0);

    // When the frame ends it cleanly, and then ends the reopened one with an error
    opened[0]?.interrupt();
    await timers.advance(999);
    const openedBeforeFirstWait = opened.length;
    await timers.advance(1);
    const openedAfterFirstWait = opened.length;
    opened[1]?.interrupt(hostFailure('TypeError: relay broke'));
    await timers.advance(1_999);
    const openedBeforeSecondWait = opened.length;
    await timers.advance(1);
    opened[2]?.receive({ siteId: 'dotli', key: 'k', value: 'v' });
    await timers.advance(0);

    // Then
    expect([openedBeforeFirstWait, openedAfterFirstWait, openedBeforeSecondWait, opened.length]).toEqual([1, 2, 2, 3]);
    expect(changes).toEqual([{ siteId: 'dotli', key: 'k', value: 'v' }]);
    expect(metrics.counted(S.PROTOCOL_FEED_END)).toEqual([
      { outcome: 'error', feed: 'shared_auth', reason: 'ProtocolFeedEndedError' },
      { outcome: 'error', feed: 'shared_auth', reason: 'TypeError' },
    ]);
    expect(captured).toEqual([{ flow: 'protocol', step: 'feed_end', tags: { feed: 'shared_auth' } }]);
    expect(errors).toHaveLength(2);
  });

  it('As a returning user, my shared auth subscription ended by the loss of its frame is not reopened there and not reported', async () => {
    // Given a subscription on a frame that is up
    const timers = manualTimers();
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const opened: ChangeSink[] = [];
    const fake = createFakeFrame(openingChanges(opened), { timers });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc(fake.frame, timers), timers });
    store.subscribeSharedAuthStorage(() => undefined);
    await timers.advance(0);

    // When the frame is lost
    fake.lose(new Error('boom'));
    await timers.advance(30_000);

    // Then
    expect(opened).toHaveLength(1);
    expect(metrics.counted(S.PROTOCOL_FEED_END)).toEqual([]);
  });

  it('As a returning user, a frame lost while my shared auth subscription asks for it is neither reported nor followed', async () => {
    // Given a subscription on a frame that is dropped in the turn the subscription asks for it
    const timers = manualTimers();
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const opened: ChangeSink[] = [];
    const fake = createFakeFrame(openingChanges(opened), { timers });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc(fake.frame, timers), timers });

    // When
    store.subscribeSharedAuthStorage(() => undefined);
    fake.lose(new Error('dropped'));
    await timers.advance(30_000);

    // Then
    expect(metrics.counted(S.PROTOCOL_FEED_END)).toEqual([]);
    expect(timers.pending()).toBe(0);
  });

  it('As a returning user, I leave while my ended shared auth subscription waits to be reopened, and it is not reopened', async () => {
    // Given a subscription the frame ended
    const timers = manualTimers();
    const opened: ChangeSink[] = [];
    const fake = createFakeFrame(openingChanges(opened), { timers });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc(fake.frame, timers), timers });
    const unsubscribe = store.subscribeSharedAuthStorage(() => undefined);
    await timers.advance(0);
    opened[0]?.interrupt();
    await timers.advance(0);

    // When
    unsubscribe();
    await timers.advance(30_000);

    // Then
    expect(opened).toHaveLength(1);
    expect(timers.pending()).toBe(0);
  });

  it.each([
    { tag: 'none' as const, read: { status: 'none' } },
    { tag: 'unreadable' as const, read: { status: 'unreadable' } },
  ])('As the host, I read a local wallet the frame answers $tag for as its status', async ({ tag, read }) => {
    // Given a frame whose local wallet store answers `tag`
    const fake = createFakeFrame(serving => {
      serving.handleRequest('wallet', 'read', () => ok({ tag, value: undefined }));
    });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc(fake.frame) });

    // When
    const result = await store.readSharedLocalWallet('dotli');

    // Then
    expect(result).toEqual(read);
  });

  it('As a local wallet user, I read my wallet with its entropy and identity', async () => {
    // Given a frame that holds a wallet
    const entropy = new Uint8Array([1, 2, 3]);
    const identity = { identityAccountId: '5Grw', liteUsername: 'alice' };
    const fake = createFakeFrame(serving => {
      serving.handleRequest('wallet', 'read', () => ok({ tag: 'ok' as const, value: { entropy, identity } }));
    });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc(fake.frame) });

    // When
    const result = await store.readSharedLocalWallet('dotli');

    // Then
    expect(result).toEqual({ status: 'ok', entropy, identity });
  });
});
