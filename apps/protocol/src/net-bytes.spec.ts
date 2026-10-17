// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { shareNetBytes, type Ticker } from './net-bytes.js';

/** A ticker the test ticks, which counts how many times it was started and how many are running. */
function testTicker(): { ticker: Ticker; tick: () => void; started: () => number; running: () => number } {
  const ticks = new Set<() => void>();
  let started = 0;
  return {
    ticker: onTick => {
      started += 1;
      ticks.add(onTick);
      return () => {
        ticks.delete(onTick);
      };
    },
    tick: () => {
      for (const tick of [...ticks]) {
        tick();
      }
    },
    started: () => started,
    running: () => ticks.size,
  };
}

describe('shareNetBytes', () => {
  it('As the network panel, I hear the byte total at once as a baseline, then on every tick until I stop', () => {
    // Given
    let total = 10;
    const clock = testTicker();
    const subscribe = shareNetBytes(() => total, clock.ticker);
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
    expect(clock.running()).toBe(0);
  });

  it('As a worker serving many tabs, I run one ticker while any tab listens and stop it with the last', () => {
    // Given
    const clock = testTicker();
    const subscribe = shareNetBytes(() => 7, clock.ticker);
    const first: number[] = [];
    const second: number[] = [];

    // When two tabs listen, the first leaves twice, and a tick passes
    const stopFirst = subscribe(total => first.push(total));
    const stopSecond = subscribe(total => second.push(total));
    stopFirst();
    stopFirst();
    clock.tick();

    // Then one ticker ran for both, and the tab that stayed still hears it
    expect(clock.started()).toBe(1);
    expect(clock.running()).toBe(1);
    expect(first).toEqual([7]);
    expect(second).toEqual([7, 7]);

    // When the last tab leaves, and a new one comes
    stopSecond();
    const running = clock.running();
    subscribe(() => undefined);

    // Then the ticker stopped with the last, and starts again for the new one
    expect(running).toBe(0);
    expect(clock.started()).toBe(2);
  });

  it('As a dotli operator, a listener that throws is reported and the others still hear the tick', () => {
    // Given
    const clock = testTicker();
    const reported: unknown[] = [];
    const subscribe = shareNetBytes(
      () => 3,
      clock.ticker,
      error => reported.push(error),
    );
    const broken = new Error('port is gone');
    let throwing = false;
    subscribe(() => {
      if (throwing) {
        throw broken;
      }
    });
    const heard: number[] = [];
    subscribe(total => heard.push(total));

    // When
    throwing = true;
    clock.tick();

    // Then
    expect(heard).toEqual([3, 3]);
    expect(reported).toEqual([broken]);
  });

  it('As a worker, a subscribe whose baseline read throws leaves no subscriber and no ticker behind', () => {
    // Given
    const clock = testTicker();
    const broken = new Error('meter is gone');
    const subscribe = shareNetBytes(() => {
      throw broken;
    }, clock.ticker);

    // When / Then
    expect(() => subscribe(() => undefined)).toThrow(broken);
    expect(clock.running()).toBe(0);
  });

  it('As a worker, a subscribe whose ticker fails to start is rolled back, and the next one starts it', () => {
    // Given a ticker that fails to start once
    const clock = testTicker();
    let failing = true;
    const ticker: Ticker = onTick => {
      if (failing) {
        failing = false;
        throw new Error('no timers');
      }
      return clock.ticker(onTick);
    };
    const subscribe = shareNetBytes(() => 5, ticker);
    const lost: number[] = [];
    const heard: number[] = [];

    // When
    expect(() => subscribe(total => lost.push(total))).toThrow('no timers');
    subscribe(total => heard.push(total));
    clock.tick();

    // Then
    expect(lost).toEqual([]);
    expect(heard).toEqual([5, 5]);
    expect(clock.running()).toBe(1);
  });

  it('As a dotli operator, a read that throws on a tick is reported and the next tick is heard', () => {
    // Given
    const clock = testTicker();
    const reported: unknown[] = [];
    const broken = new Error('meter is gone');
    let total: number | null = 1;
    const subscribe = shareNetBytes(
      () => {
        if (total === null) {
          throw broken;
        }
        return total;
      },
      clock.ticker,
      error => reported.push(error),
    );
    const heard: number[] = [];
    subscribe(received => heard.push(received));

    // When
    total = null;
    clock.tick();
    total = 9;
    clock.tick();

    // Then
    expect(reported).toEqual([broken]);
    expect(heard).toEqual([1, 9]);
  });
});
