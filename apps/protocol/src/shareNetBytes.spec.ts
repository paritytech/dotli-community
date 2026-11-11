// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { catchError } from '@dotli/shared/testing';
import { createTestTicker } from './createIntervalTicker.fake.js';
import { shareNetBytes } from './shareNetBytes.js';

describe('shareNetBytes', () => {
  it('As the network panel, I subscribe and hear the byte total at once as a baseline, then on every tick until I stop', () => {
    // Given
    let total = 10;
    const clock = createTestTicker();
    const subscribe = shareNetBytes({ read: () => total, startTicker: clock.startTicker });
    const posted: number[] = [];

    // When
    const stop = subscribe(received => posted.push(received));
    total = 25;
    clock.tick();
    stop();
    total = 40;
    clock.tick();

    // Then
    expect(posted).toEqual([10, 25]);
    expect(clock.countRunning()).toBe(0);
  });

  it('As a worker serving many tabs, I run one ticker while any tab listens and the tab that stays hears each tick', () => {
    // Given
    const clock = createTestTicker();
    const subscribe = shareNetBytes({ read: () => 7, startTicker: clock.startTicker });
    const first: number[] = [];
    const second: number[] = [];

    // When two tabs listen, the first leaves twice, and a tick passes
    const stopFirst = subscribe(total => first.push(total));
    subscribe(total => second.push(total));
    stopFirst();
    stopFirst();
    clock.tick();

    // Then one ticker ran for both, and the tab that stayed still hears it
    expect(clock.countStarted()).toBe(1);
    expect(clock.countRunning()).toBe(1);
    expect(first).toEqual([7]);
    expect(second).toEqual([7, 7]);
  });

  it('As a worker serving many tabs, I stop the ticker with the last tab and start it again for the next', () => {
    // Given two tabs that listened, the first of which left
    const clock = createTestTicker();
    const subscribe = shareNetBytes({ read: () => 7, startTicker: clock.startTicker });
    const stopFirst = subscribe(() => undefined);
    const stopSecond = subscribe(() => undefined);
    stopFirst();

    // When the last tab leaves, and a new one comes
    stopSecond();
    const running = clock.countRunning();
    subscribe(() => undefined);

    // Then the ticker stopped with the last, and starts again for the new one
    expect(running).toBe(0);
    expect(clock.countStarted()).toBe(2);
  });

  it('As a worker, I subscribe while the baseline read throws and leave no subscriber and no ticker behind', () => {
    // Given
    const clock = createTestTicker();
    const broken = new Error('meter is gone');
    const subscribe = shareNetBytes({
      read() {
        throw broken;
      },
      startTicker: clock.startTicker,
    });

    // When
    const thrown = catchError(() => subscribe(() => undefined));

    // Then
    expect(thrown).toBe(broken);
    expect(clock.countRunning()).toBe(0);
  });

  it('As a worker, I subscribe while the ticker fails to start and roll back, so the next subscribe starts it', () => {
    // Given a ticker that fails to start once
    const clock = createTestTicker();
    let failing = true;
    function startTicker(onTick: () => void): () => void {
      if (failing) {
        failing = false;
        throw new Error('no timers');
      }
      return clock.startTicker(onTick);
    }
    const subscribe = shareNetBytes({ read: () => 5, startTicker });
    const lost: number[] = [];
    const heard: number[] = [];

    // When
    const thrown = catchError(() => subscribe(total => lost.push(total)));
    subscribe(total => heard.push(total));
    clock.tick();

    // Then
    expect(thrown).toMatchObject({ message: 'no timers' });
    expect(lost).toEqual([]);
    expect(heard).toEqual([5, 5]);
    expect(clock.countRunning()).toBe(1);
  });

  it('As a dotli operator, I watch the meter fail tick after tick and see it reported once per run of failures, as the meter', () => {
    // Given a meter whose reads I break and mend
    const clock = createTestTicker();
    const readFailures: unknown[] = [];
    const listenerFailures: unknown[] = [];
    const broken = new Error('meter is gone');
    let total: number | null = 1;
    const subscribe = shareNetBytes({
      read() {
        if (total === null) {
          throw broken;
        }
        return total;
      },
      startTicker: clock.startTicker,
      report: error => listenerFailures.push(error),
      reportRead: error => readFailures.push(error),
    });
    const heard: number[] = [];
    subscribe(received => heard.push(received));

    // When the read fails on two ticks in a row, works on the next, then fails again
    total = null;
    clock.tick();
    clock.tick();
    total = 9;
    clock.tick();
    total = null;
    clock.tick();

    // Then each run of failures was reported once, as the meter's, and the good tick was heard
    expect(readFailures).toEqual([broken, broken]);
    expect(listenerFailures).toEqual([]);
    expect(heard).toEqual([1, 9]);
  });
});
