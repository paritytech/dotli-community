// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { describeProgressStall, describeStall, SLOW_BYTES_PER_SECOND } from './warnings.js';

describe('describeStall throughput', () => {
  it.each<{ story: string; outcome: string; stall: Parameters<typeof describeStall>[0]; expected: string | null }>([
    {
      story: 'on a slow connection',
      outcome: 'see the real rate rather than zero',
      stall: { chain: 'relay', peers: 2, bytesPerSecond: 300 },
      expected: 'Fetching Polkadot from 2 computers at 300 B/s. Slower than usual.',
    },
    {
      story: 'with nothing arriving',
      outcome: 'am told that instead of shown a zero rate',
      stall: { chain: 'relay', peers: 2, bytesPerSecond: 0.4 },
      expected: 'Connected to 2 computers for Polkadot, but no data is arriving yet.',
    },
    {
      story: 'on an ordinary connection',
      outcome: 'see the rate in kilobytes',
      stall: { chain: 'relay', peers: 2, bytesPerSecond: 2048 },
      expected: 'Fetching Polkadot from 2 computers at 2 kB/s. Slower than usual.',
    },
    {
      story: 'just under the slow-load rate',
      outcome: 'am still told the load is slow',
      stall: { chain: 'bulletin', peers: 1, bytesPerSecond: SLOW_BYTES_PER_SECOND - 1024 },
      expected: 'Fetching the app files from 1 computer at 127 kB/s. Slower than usual.',
    },
    {
      story: 'on a fine connection',
      outcome: 'see no warning while a chain takes its time',
      stall: { chain: 'bulletin', peers: 1, bytesPerSecond: SLOW_BYTES_PER_SECOND },
      expected: null,
    },
  ])('As a user $story, I wait on a chain and $outcome', ({ stall, expected }) => {
    // When
    const warning = describeStall(stall);

    // Then
    expect(warning).toBe(expected);
  });
});

describe('describeProgressStall', () => {
  it.each<{ story: string; outcome: string; bytesPerSecond: number | null; expected: string | null }>([
    {
      story: 'whose load is slow before any reading arrives',
      outcome: 'am not told it is my connection',
      bytesPerSecond: null,
      expected: 'Still working. This is taking longer than usual.',
    },
    {
      story: 'whose load is busy without downloading',
      outcome: 'am not told it is my connection',
      bytesPerSecond: 0,
      expected: 'Still working. This is taking longer than usual.',
    },
    {
      story: 'on a fine connection',
      outcome: 'see no warning while the bar waits',
      bytesPerSecond: 2_097_152,
      expected: null,
    },
    {
      story: 'on a slow download',
      outcome: 'see the real rate',
      bytesPerSecond: 2048,
      expected: 'Still downloading at 2 kB/s. That is slower than this app usually needs, so give it a moment.',
    },
  ])('As a user $story, I wait on the bar and $outcome', ({ bytesPerSecond, expected }) => {
    // When
    const warning = describeProgressStall(bytesPerSecond);

    // Then
    expect(warning).toBe(expected);
  });
});
