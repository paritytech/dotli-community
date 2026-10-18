// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { createStatusCell, deferred, type StatusCell } from '@dotli/shared';
import { manualTimers, recordLog, type ManualTimers } from '@dotli/shared/testing';
import { createFeedKeeper, type FeedEnds, type FeedFrame, type FeedName } from './feed.js';
import type { ProtocolStatus } from './frame.js';

/** A frame's transport, known here by name only. */
interface Transport {
  name: string;
}

/** A subscription the keeper holds on `transport`. */
interface HeldSubscription extends FeedEnds {
  transport: Transport;
  unsubscribed: boolean;
}

describe('createFeedKeeper', () => {
  let timers: ManualTimers;
  let opened: HeldSubscription[];
  let current: Transport;

  let status: StatusCell<ProtocolStatus>;
  /** The frame, ready with `current` as its transport unless a test says otherwise. */
  const frameOf = (transport = (): Promise<Transport> => Promise.resolve(current)): FeedFrame<Transport> => ({
    getStatus: status.get,
    subscribeStatus: status.subscribe,
    transport,
  });

  /** A keeper following `frame`, recording each subscription it opens. */
  const keeperOf = (feed: FeedName, frame = frameOf(), boots = true) =>
    createFeedKeeper(
      feed,
      frame,
      transport => ends => {
        const held: HeldSubscription = { transport, unsubscribed: false, ...ends };
        opened.push(held);
        return () => {
          held.unsubscribed = true;
        };
      },
      { boots, timers },
    );

  beforeEach(() => {
    timers = manualTimers();
    opened = [];
    current = { name: 'first' };
    status = createStatusCell<ProtocolStatus>('ready', {
      onListenerError: error => {
        throw error;
      },
    });
    recordLog({ onFinished: onTestFinished });
  });

  it('As the host, a feed the frame keeps ending waits twice as long before each reopen, and never more than 30 s', async () => {
    // Given
    keeperOf('telemetry').follow();
    await timers.advance(0);
    const waits: number[] = [];

    // When the frame ends each reopened feed at once, waiting at most one step past the cap for each reopen
    for (let ended = 0; ended < 7; ended++) {
      const before = opened.length;
      opened.at(-1)?.end(null);
      let waited = 0;
      while (opened.length === before && waited <= 30_000) {
        await timers.advance(1_000);
        waited += 1_000;
      }
      waits.push(waited);
    }

    // Then
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('As the host, a feed that stayed open for a while before it ended is reopened after the first wait again', async () => {
    // Given a feed the frame ended at once twice, so the next wait would be 4 s
    keeperOf('telemetry').follow();
    await timers.advance(0);
    opened.at(-1)?.end(null);
    await timers.advance(1_000);
    opened.at(-1)?.end(null);
    await timers.advance(2_000);

    // When the reopened feed stays open for 30 s, then ends
    await timers.advance(30_000);
    opened.at(-1)?.end(null);
    await timers.advance(999);
    const openedBeforeWait = opened.length;
    await timers.advance(1);

    // Then
    expect([openedBeforeWait, opened.length]).toEqual([3, 4]);
  });

  it('As an operator, I see every end of a feed counted and logged as it happens, and captured once while it is held', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordCaptures({ onFinished: onTestFinished });
    const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
    keeperOf('shared_auth').follow();
    await timers.advance(0);

    // When the frame ends the feed three times
    const countedAtEach: number[] = [];
    for (const wait of [1_000, 2_000, 4_000]) {
      opened.at(-1)?.end(new TypeError('relay broke'));
      countedAtEach.push(metrics.counted(S.PROTOCOL_FEED_END).length);
      await timers.advance(wait);
    }

    // Then
    expect(countedAtEach).toEqual([1, 2, 3]);
    expect(metrics.counted(S.PROTOCOL_FEED_END)[0]).toEqual({
      outcome: 'error',
      feed: 'shared_auth',
      reason: 'TypeError',
    });
    expect(errors).toHaveLength(3);
    expect(captured).toEqual([{ flow: 'protocol', step: 'feed_end', tags: { feed: 'shared_auth' } }]);
  });

  it('As the host, a feed whose transport closes under it is neither reported nor reopened', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordCaptures({ onFinished: onTestFinished });
    keeperOf('telemetry').follow();
    await timers.advance(0);

    // When
    opened[0]?.close();
    await timers.advance(30_000);

    // Then
    expect(opened).toHaveLength(1);
    expect(timers.pending()).toBe(0);
    expect(metrics.counted(S.PROTOCOL_FEED_END)).toEqual([]);
    expect(captured).toEqual([]);
  });

  it('As the host, my feed follows each frame that boots, and the feed held on the old one is unsubscribed', async () => {
    // Given one feed held, and following the same transport again
    const keeper = keeperOf('shared_auth');
    keeper.follow();
    await timers.advance(0);
    keeper.follow();
    await timers.advance(0);

    // When a new frame boots
    current = { name: 'second' };
    status.set('failed');
    status.set('booting');
    await timers.advance(0);

    // Then
    expect(opened.map(({ transport, unsubscribed }) => [transport.name, unsubscribed])).toEqual([
      ['first', true],
      ['second', false],
    ]);
  });

  it('As the host, a feed let go during the wait after an end is not reopened, and an ask still out is dropped', async () => {
    // Given a feed the frame ended, waiting to be reopened, and a frame whose next transport is still being asked for
    const asked = deferred<Transport>();
    let transport = (): Promise<Transport> => Promise.resolve(current);
    const keeper = keeperOf(
      'shared_auth',
      frameOf(() => transport()),
    );
    keeper.follow();
    await timers.advance(0);
    opened[0]?.end(new TypeError('relay broke'));
    transport = () => asked.promise;
    keeper.follow();

    // When the last listener leaves before the wait ends and before the frame answers
    keeper.stop();
    asked.resolve({ name: 'second' });
    await timers.advance(30_000);

    // Then
    expect(opened).toHaveLength(1);
    expect(timers.pending()).toBe(0);
  });

  it('As the host, a feed that boots no frame hears none while the frame is down, then the next one that boots', async () => {
    // Given a frame that is down, and telemetry that never boots one
    status.set('idle');
    let asked = 0;
    const keeper = keeperOf(
      'telemetry',
      frameOf(() => {
        asked += 1;
        return Promise.resolve(current);
      }),
      false,
    );

    // When the feed is followed, and a frame boots later
    keeper.follow();
    await timers.advance(0);
    const askedWhileDown = asked;
    status.set('booting');
    await timers.advance(0);

    // Then
    expect([askedWhileDown, asked, opened.length]).toEqual([0, 1, 1]);
  });

  it('As the host, a feed let go is not followed onto the next frame', async () => {
    // Given
    const keeper = keeperOf('shared_auth');
    keeper.follow();
    await timers.advance(0);

    // When the last listener leaves, and a new frame boots
    keeper.stop();
    current = { name: 'second' };
    status.set('failed');
    status.set('booting');
    await timers.advance(0);

    // Then
    expect(opened.map(({ transport, unsubscribed }) => [transport.name, unsubscribed])).toEqual([['first', true]]);
  });
});
