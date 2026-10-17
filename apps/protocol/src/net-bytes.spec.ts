// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { reportNetBytes, type Ticker } from './net-bytes.js';

describe('reportNetBytes', () => {
  it('As the network panel, I hear the byte total at once as a baseline, then on every tick until the report stops', () => {
    // Given
    let total = 10;
    const posted: number[] = [];
    let tick: () => void = () => undefined;
    let stopped = false;
    const ticker: Ticker = onTick => {
      tick = onTick;
      return () => {
        stopped = true;
      };
    };

    // When
    const stop = reportNetBytes(
      () => total,
      received => posted.push(received),
      ticker,
    );
    total = 25;
    tick();
    stop();

    // Then
    expect(posted).toEqual([10, 25]);
    expect(stopped).toBe(true);
  });
});
