// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { bindLogSink } from '@dotli/shared';
import { manualTimers, type ManualTimers } from '@dotli/shared/testing';
import { createFeedKeeper } from './feed.js';
import type { Subscription } from './transport-consumer.js';

interface HeldSubscription extends Subscription {
  /** The frame ending it, cleanly with null. */
  end(error: Error | null): void;
  unsubscribed: boolean;
}

function heldSubscription(): HeldSubscription {
  let endListener: ((error: Error | null) => void) | null = null;
  const held: HeldSubscription = {
    unsubscribed: false,
    unsubscribe() {
      held.unsubscribed = true;
      endListener = null;
    },
    onEnd(listener) {
      endListener = listener;
    },
    end(error) {
      endListener?.(error);
    },
  };
  return held;
}

describe('createFeedKeeper', () => {
  let timers: ManualTimers;
  let opened: HeldSubscription[];
  const open = (): Subscription => {
    const subscription = heldSubscription();
    opened.push(subscription);
    return subscription;
  };

  beforeEach(() => {
    timers = manualTimers();
    opened = [];
    onTestFinished(bindLogSink({ emit: () => undefined }));
  });

  it('As the host, a feed the frame keeps ending waits twice as long before each reopen, and never more than 30 s', async () => {
    // Given
    const keeper = createFeedKeeper('telemetry', { losses: () => 0 }, timers);
    keeper.hold(open, 0);
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
    const keeper = createFeedKeeper('telemetry', { losses: () => 0 }, timers);
    keeper.hold(open, 0);
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

  it('As an operator, I see every end of a feed counted and logged, and captured once while it is held', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordCaptures({ onFinished: onTestFinished });
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
    const keeper = createFeedKeeper('telemetry', { losses: () => 0 }, timers);
    keeper.hold(open, 0);

    // When the frame ends the feed three times
    for (const wait of [1_000, 2_000, 4_000]) {
      opened.at(-1)?.end(null);
      await timers.advance(wait);
    }

    // Then
    expect(metrics.counted(S.PROTOCOL_FEED_END)).toHaveLength(3);
    expect(errors).toHaveLength(3);
    expect(captured).toEqual([{ flow: 'protocol', step: 'feed_end', tags: { feed: 'telemetry' } }]);
  });

  it.each([
    ['the frame stays up', 0, 1],
    ['the frame counted a loss meanwhile', 1, 0],
  ] as const)(
    'As an operator, a feed let go during the wait after an end is reported then unless the end was a loss, when %s',
    async (_case, lossesMeanwhile, reported) => {
      // Given a feed the frame ended, waiting to be reopened
      const metrics = bindRecordingSentry({ onFinished: onTestFinished });
      let losses = 0;
      const keeper = createFeedKeeper('shared_auth', { losses: () => losses }, timers);
      keeper.hold(open, 0);
      opened[0]?.end(new TypeError('relay broke'));
      await timers.advance(500);
      losses += lossesMeanwhile;

      // When the last listener leaves before the wait ends
      keeper.stop();
      await timers.advance(30_000);

      // Then
      expect(metrics.counted(S.PROTOCOL_FEED_END)).toHaveLength(reported);
      expect(opened).toHaveLength(1);
      expect(timers.pending()).toBe(0);
    },
  );

  it('As the host, I hold a new feed and the one held before is unsubscribed, and its waiting reopen dropped', async () => {
    // Given one feed held, and another that ended and waits to be reopened
    const keeper = createFeedKeeper('shared_auth', { losses: () => 0 }, timers);
    keeper.hold(open, 0);
    const first = opened[0];
    keeper.hold(open, 0);
    const second = opened[1];
    second?.end(new Error('relay broke'));

    // When
    keeper.hold(open, 0);
    await timers.advance(30_000);

    // Then
    expect(first?.unsubscribed).toBe(true);
    expect(opened).toHaveLength(3);
    expect(opened[2]?.unsubscribed).toBe(false);
  });

  it.each([
    ['the frame counts its loss before the feed ends', 'loss first'],
    ['the feed ends before the frame counts its loss', 'end first'],
  ] as const)(
    'As the host, a feed ended by the loss of its frame is neither reported nor reopened when %s',
    async (_order, order) => {
      // Given
      const metrics = bindRecordingSentry({ onFinished: onTestFinished });
      const captured = recordCaptures({ onFinished: onTestFinished });
      let losses = 0;
      const keeper = createFeedKeeper('telemetry', { losses: () => losses }, timers);
      keeper.hold(open, 0);

      // When
      if (order === 'loss first') {
        losses += 1;
        opened[0]?.end(new Error('frame lost'));
      } else {
        opened[0]?.end(new Error('handshake refused'));
        await timers.advance(0);
        losses += 1;
      }
      await timers.advance(30_000);

      // Then
      expect(opened).toHaveLength(1);
      expect(timers.pending()).toBe(0);
      expect(metrics.counted(S.PROTOCOL_FEED_END)).toEqual([]);
      expect(captured).toEqual([]);
    },
  );

  it('As the host, a feed the frame ended while it stayed up is reported once the wait shows the frame still up', async () => {
    // Given a feed the frame ended
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const keeper = createFeedKeeper('shared_auth', { losses: () => 0 }, timers);
    keeper.hold(open, 0);
    opened[0]?.end(new TypeError('relay broke'));

    // When the wait before the reopen passes
    await timers.advance(999);
    const countedDuringWait = metrics.counted(S.PROTOCOL_FEED_END).length;
    await timers.advance(1);

    // Then
    expect(countedDuringWait).toBe(0);
    expect(metrics.counted(S.PROTOCOL_FEED_END)).toEqual([
      { outcome: 'error', feed: 'shared_auth', reason: 'TypeError' },
    ]);
    expect(opened).toHaveLength(2);
  });
});
