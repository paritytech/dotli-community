// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { atom, STORE_UNMOUNT_DELAY } from 'nanostores';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import { createManualTimers, recordLog } from '@dotli/shared/testing';
import { err, hostFailure, ok, type Sink } from '@dotli/transport';
import type { ProtocolFrame, ProtocolStatus } from './frameTypes.js';
import { createFrameRpc } from './createFrameRpc.js';
import type { SharedAuthChange, SubscriptionEnd } from './schema.js';
import { createSharedStore, type SharedStoreStatus } from './createSharedStore.js';
import { createFakeFrame } from './createProtocolFrame.fake.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';

const { storage, wallet } = protocolSchema.sections;

type ChangeSink = Sink<SharedAuthChange, SubscriptionEnd<undefined>>;

/** A frame app that relays sibling tabs' auth changes, keeping each subscriber's sink while it is subscribed. */
function createRelayingFrame(sinks: Set<ChangeSink>): (serving: ProtocolTransport) => void {
  return serving => {
    serving.handleSubscription(storage.authChanges, (_start, _context, sink) => {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    });
  };
}

/** A frame app that keeps the sink of every auth change subscription it was asked for, in order. */
function createOpeningFrame(opened: ChangeSink[]): (serving: ProtocolTransport) => void {
  return serving => {
    serving.handleSubscription(storage.authChanges, (_start, _context, sink) => {
      opened.push(sink);
      return () => undefined;
    });
  };
}

describe('createSharedStore', () => {
  it('As a returning user, I see my shared store connecting until a first frame listens, then down from each loss until a frame listens again', () => {
    // Given
    const fake = createFakeFrame({ status: 'idle' });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc({ frame: fake.frame }) });
    const statuses: SharedStoreStatus[] = [];
    store.status.listen(status => statuses.push(status));
    const atStart = store.status.get();

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

  it.each(['failed', 'booting'] as const)(
    'As a returning user whose light client failed to start, I see my shared store available while the frame holds it, as the frame is %s',
    at => {
      // Given a store whose frame settled, and whose frame now holds the store
      const fake = createFakeFrame({ status: 'listening' });
      const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc({ frame: fake.frame }) });
      fake.holdStore(true);
      fake.setStatus(at);
      const whileHeld = store.status.get();

      // When the frame lets the store go
      fake.holdStore(false);

      // Then
      expect(whileHeld).toBe('available');
      expect(store.status.get()).toBe('unavailable');
    },
  );

  it('As a dotli integrator, I subscribe the frame status before the shared store is built and read the store available the moment the frame listens', () => {
    // Given a frame status listener registered before the shared store, which reads the store on each change
    const fake = createFakeFrame({ status: 'idle' });
    let store: ReturnType<typeof createSharedStore> | null = null;
    const read: (SharedStoreStatus | undefined)[] = [];
    fake.frame.status.listen(() => {
      read.push(store?.status.get());
    });
    store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc({ frame: fake.frame }) });

    // When
    fake.setStatus('booting');
    fake.setStatus('listening');

    // Then
    expect(read).toEqual(['connecting', 'available']);
  });

  it('As a returning user, I see my shared store read connecting until the new frame listens when a frame status listener rebuilds the frame as it listens, and hear only that it is available', () => {
    // Given a frame that publishes its status as the real one does, a listener first in line that rebuilds the frame
    // the first time it listens, and a shared store built after that listener
    const cell = atom<ProtocolStatus>('idle');
    const frame: ProtocolFrame = {
      ...createFakeFrame().frame,
      status: cell,
    };
    let rebuilt = false;
    cell.listen(next => {
      if (next === 'listening' && !rebuilt) {
        rebuilt = true;
        cell.set('idle');
        cell.set('booting');
      }
    });
    const store = createSharedStore({ frame, rpc: createFrameRpc({ frame }) });
    const statuses: SharedStoreStatus[] = [];
    store.status.listen(status => statuses.push(status));

    // When the first frame listens and is rebuilt at once
    cell.set('booting');
    cell.set('listening');

    // Then the store never heard the first frame listen, so it reads connecting while the new frame boots
    expect(store.status.get()).toBe('connecting');

    // When the new frame listens
    cell.set('listening');

    // Then the store is available, the one change its listener heard
    expect(store.status.get()).toBe('available');
    expect(statuses).toEqual(['available']);
  });

  it('As a dotli integrator, I read the shared store with nobody listening while its frame settles and boots again, and read it unavailable', () => {
    // Given a store read once with nobody listening while its frame boots, left until its status unmounts
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const fake = createFakeFrame({ status: 'booting' });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc({ frame: fake.frame }) });
    store.status.get();
    // nanostores' unmount timer has no seam, and `cleanStores` would clear the cache this case pins.
    vi.advanceTimersByTime(STORE_UNMOUNT_DELAY);

    // When the frame listens and boots again, with nobody listening
    fake.setStatus('listening');
    fake.setStatus('booting');

    // Then
    expect(store.status.get()).toBe('unavailable');
  });

  it("As a returning user, I hear another tab's shared auth write, and my subscription waits only for a listening frame", async () => {
    // Given a frame still booting, and a subscription made while it boots
    const timers = createManualTimers();
    const warnings = recordLog({ onFinished: onTestFinished, level: 'warn' });
    const sinks = new Set<ChangeSink>();
    const fake = createFakeFrame({ serve: createRelayingFrame(sinks), status: 'booting', timers });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc({ frame: fake.frame, timers }) });
    const changes: SharedAuthChange[] = [];
    store.auth.subscribe(change => changes.push(change));
    await timers.advance(0);
    const subscribedWhileBooting = sinks.size;

    // When the frame listens, a sibling tab writes, and the frame is dropped before it is ready
    fake.setStatus('listening');
    await timers.advance(0);
    for (const sink of sinks) {
      sink.send({ tag: 'session', value: { siteId: 'dotli', key: 'k', value: 'v' } });
    }
    await timers.advance(0);
    fake.setStatus('idle');
    await timers.advance(0);

    // Then the write reached me, and the listening frame met the subscription's wait, so the drop is no failure
    expect(subscribedWhileBooting).toBe(0);
    expect(changes).toEqual([{ tag: 'session', value: { siteId: 'dotli', key: 'k', value: 'v' } }]);
    expect(warnings).toEqual([]);
  });

  it('As a returning user, I keep my shared auth subscription on each new frame, and it stops in the frame once I leave', async () => {
    // Given a subscription on a frame that is then lost and rebuilt
    const timers = createManualTimers();
    const sinks = new Set<ChangeSink>();
    const fake = createFakeFrame({ serve: createRelayingFrame(sinks), timers });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc({ frame: fake.frame, timers }) });
    const changes: SharedAuthChange[] = [];
    const unsubscribe = store.auth.subscribe(change => changes.push(change));
    await timers.advance(0);
    fake.lose(new Error('boom'));
    fake.setStatus('booting');
    fake.setStatus('listening');
    await timers.advance(0);
    const subscribedOnRebuilt = sinks.size;

    // When a sibling tab writes, and then I leave
    for (const sink of sinks) {
      sink.send({ tag: 'session', value: { siteId: 'dotli', key: 'k', value: null } });
    }
    await timers.advance(0);
    unsubscribe();
    await timers.advance(0);

    // Then
    expect(subscribedOnRebuilt).toBe(1);
    expect(changes).toEqual([{ tag: 'session', value: { siteId: 'dotli', key: 'k', value: null } }]);
    expect(sinks.size).toBe(0);
  });

  it('As a returning user, I see my shared auth subscription the frame ends while it stays up reopened after a wait that doubles, and each end reported and captured once', async () => {
    // Given a subscription on a frame that stays up
    const timers = createManualTimers();
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
    const opened: ChangeSink[] = [];
    const fake = createFakeFrame({ serve: createOpeningFrame(opened), timers });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc({ frame: fake.frame, timers }), timers });
    const changes: SharedAuthChange[] = [];
    store.auth.subscribe(change => changes.push(change));
    await timers.advance(0);

    // When the frame ends it cleanly, and then ends the reopened one with an error
    opened[0]?.interrupt(ok());
    await timers.advance(999);
    const openedBeforeFirstWait = opened.length;
    await timers.advance(1);
    const openedAfterFirstWait = opened.length;
    opened[1]?.interrupt(err(hostFailure('TypeError: relay broke')));
    await timers.advance(1_999);
    const openedBeforeSecondWait = opened.length;
    await timers.advance(1);
    opened[2]?.send({ tag: 'session', value: { siteId: 'dotli', key: 'k', value: 'v' } });
    await timers.advance(0);

    // Then
    expect([openedBeforeFirstWait, openedAfterFirstWait, openedBeforeSecondWait, opened.length]).toEqual([1, 2, 2, 3]);
    expect(changes).toEqual([{ tag: 'session', value: { siteId: 'dotli', key: 'k', value: 'v' } }]);
    expect(metrics.counted('protocol.feed_end')).toEqual([
      { outcome: 'error', feed: 'shared_auth', reason: 'ProtocolFeedEndedError' },
      { outcome: 'error', feed: 'shared_auth', reason: 'TypeError' },
    ]);
    expect(captured).toMatchObject([{ step: 'feed_end', tags: { feed: 'shared_auth' } }]);
    expect(errors).toHaveLength(2);
  });

  it('As a returning user, I lose a frame while my shared auth subscription asks for it and it is neither reported nor followed', async () => {
    // Given a subscription on a frame that is dropped in the turn the subscription asks for it
    const timers = createManualTimers();
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const opened: ChangeSink[] = [];
    const fake = createFakeFrame({ serve: createOpeningFrame(opened), timers });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc({ frame: fake.frame, timers }), timers });

    // When
    store.auth.subscribe(() => undefined);
    fake.lose(new Error('dropped'));
    await timers.advance(30_000);

    // Then
    expect(metrics.counted('protocol.feed_end')).toEqual([]);
    expect(timers.countPending()).toBe(0);
  });

  it.each([
    { tag: 'none' as const, read: { status: 'none' } },
    { tag: 'unreadable' as const, read: { status: 'unreadable' } },
  ])('As the host, I read a local wallet the frame answers $tag for as its status', async ({ tag, read }) => {
    // Given a frame whose local wallet store answers `tag`
    const fake = createFakeFrame({
      serve: serving => {
        serving.handleRequest(wallet.read, () => ok({ tag, value: undefined }));
      },
    });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc({ frame: fake.frame }) });

    // When
    const result = await store.wallet.read('dotli');

    // Then
    expect(result).toEqual(read);
  });

  it('As a local wallet user, I read my wallet with its entropy, identity and version', async () => {
    // Given a frame that holds a wallet
    const entropy = new Uint8Array([1, 2, 3]);
    const identity = { identityAccountId: '5Grw', liteUsername: 'alice' };
    const version = new Uint8Array([9, 9]);
    const fake = createFakeFrame({
      serve: serving => {
        serving.handleRequest(wallet.read, () => ok({ tag: 'ok' as const, value: { entropy, identity, version } }));
      },
    });
    const store = createSharedStore({ frame: fake.frame, rpc: createFrameRpc({ frame: fake.frame }) });

    // When the wallet is read
    const result = await store.wallet.read('dotli');

    // Then it carries the entropy, the identity and the version
    expect(result).toEqual({ status: 'ok', entropy, identity, version });
  });
});
