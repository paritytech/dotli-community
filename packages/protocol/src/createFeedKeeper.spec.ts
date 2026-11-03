// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { atom, type WritableAtom } from 'nanostores';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import { createManualTimers, recordLog, type ManualTimers } from '@dotli/shared/testing';
import { createFeedKeeper, type FeedEnds, type FeedFrame, type FeedName } from './createFeedKeeper.js';
import type { ProtocolStatus } from './frameTypes.js';

/** A frame's transport, known here by name only. */
type Transport = {
  name: string;
};

/** A subscription the keeper holds on `transport`. */
type HeldSubscription = {
  transport: Transport;
  unsubscribed: boolean;
} & FeedEnds;

type Params = {
  frame?: FeedFrame<Transport>;
  boots?: boolean;
};

describe('createFeedKeeper', () => {
  let timers: ManualTimers;
  let opened: HeldSubscription[];
  let current: Transport;

  let status: WritableAtom<ProtocolStatus>;
  /** The frame, ready with `current` as its transport unless a test says otherwise. */
  function createFrame(transport = (): Promise<Transport> => Promise.resolve(current)): FeedFrame<Transport> {
    return {
      status,
      getTransport: transport,
    };
  }

  /** A keeper following `frame`, recording each subscription it opens. */
  function createKeeper(feed: FeedName, { frame = createFrame(), boots = true }: Params = {}) {
    return createFeedKeeper({
      feed,
      frame,
      opener: transport => ends => {
        const held: HeldSubscription = { transport, unsubscribed: false, ...ends };
        opened.push(held);
        return () => {
          held.unsubscribed = true;
        };
      },
      boots,
      timers,
    });
  }

  beforeEach(() => {
    timers = createManualTimers();
    opened = [];
    current = { name: 'first' };
    status = atom<ProtocolStatus>('ready');
    recordLog({ onFinished: onTestFinished });
  });

  it('As the host, I see a feed the frame keeps ending wait twice as long before each reopen, and never more than 30 s', async () => {
    // Given
    createKeeper('telemetry').follow();
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

  it('As the host, I see a feed that stayed open for a while before it ended reopened after the first wait again', async () => {
    // Given a feed the frame ended at once twice, so the next wait would be 4 s
    createKeeper('telemetry').follow();
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
    createKeeper('shared_auth').follow();
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

  it('As the host, I lose the transport under a feed and the feed is neither reported nor reopened', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordCaptures({ onFinished: onTestFinished });
    createKeeper('telemetry').follow();
    await timers.advance(0);

    // When
    opened[0]?.close();
    await timers.advance(30_000);

    // Then
    expect(opened).toHaveLength(1);
    expect(timers.countPending()).toBe(0);
    expect(metrics.counted(S.PROTOCOL_FEED_END)).toEqual([]);
    expect(captured).toEqual([]);
  });

  it('As the host, I keep my feed on each frame that boots, and the feed held on the old one is unsubscribed', async () => {
    // Given one feed held, and following the same transport again
    const keeper = createKeeper('shared_auth');
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

  it('As the host, I let go of a feed during the wait after an end, so it is not reopened and an ask still out is dropped', async () => {
    // Given a feed the frame ended, waiting to be reopened, and a frame whose next transport is still being asked for
    const asked = createDeferred<Transport>();
    let transport = (): Promise<Transport> => Promise.resolve(current);
    const keeper = createKeeper('shared_auth', { frame: createFrame(() => transport()) });
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
    expect(timers.countPending()).toBe(0);
  });

  it('As the host, I follow a feed that boots no frame and it hears none while the frame is down, then the next one that boots', async () => {
    // Given a frame that is down, and telemetry that never boots one
    status.set('idle');
    let asked = 0;
    const keeper = createKeeper('telemetry', {
      frame: createFrame(() => {
        asked += 1;
        return Promise.resolve(current);
      }),
      boots: false,
    });

    // When the feed is followed, and a frame boots later
    keeper.follow();
    await timers.advance(0);
    const askedWhileDown = asked;
    status.set('booting');
    await timers.advance(0);

    // Then
    expect([askedWhileDown, asked, opened.length]).toEqual([0, 1, 1]);
  });

  it('As the host, I let go of a feed and it is not followed onto the next frame', async () => {
    // Given
    const keeper = createKeeper('shared_auth');
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
