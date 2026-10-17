// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
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
    keeper.hold(open);
    const waits: number[] = [];

    // When the frame ends each reopened feed at once
    for (let ended = 0; ended < 7; ended++) {
      const before = opened.length;
      opened.at(-1)?.end(null);
      let waited = 0;
      while (opened.length === before) {
        await timers.advance(1_000);
        waited += 1_000;
      }
      waits.push(waited);
    }

    // Then
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('As the host, I hold a new feed and the one held before is unsubscribed, and its waiting reopen dropped', async () => {
    // Given one feed held, and another that ended and waits to be reopened
    const keeper = createFeedKeeper('shared_auth', { losses: () => 0 }, timers);
    keeper.hold(open);
    const first = opened[0];
    keeper.hold(open);
    const second = opened[1];
    second?.end(new Error('relay broke'));

    // When
    keeper.hold(open);
    await timers.advance(30_000);

    // Then
    expect(first?.unsubscribed).toBe(true);
    expect(opened).toHaveLength(3);
    expect(opened[2]?.unsubscribed).toBe(false);
  });

  it('As the host, a feed that ends once its frame is lost is neither reopened nor kept waiting', async () => {
    // Given
    let losses = 0;
    const keeper = createFeedKeeper('telemetry', { losses: () => losses }, timers);
    keeper.hold(open);

    // When
    losses += 1;
    opened[0]?.end(new Error('frame lost'));
    await timers.advance(30_000);

    // Then
    expect(opened).toHaveLength(1);
    expect(timers.pending()).toBe(0);
  });
});
