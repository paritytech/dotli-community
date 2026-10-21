// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { describeProgressStall, describeStall, SLOW_BYTES_PER_SECOND } from './warnings.js';

describe('describeStall throughput', () => {
  it('As a user on a slow connection, I see the real rate rather than zero', () => {
    // When / Then
    expect(describeStall({ chain: 'relay', peers: 2, bytesPerSecond: 300 })).toBe(
      'Fetching Polkadot from 2 computers at 300 B/s. Slower than usual.',
    );
  });

  it('As a user with nothing arriving, I am told that instead of shown a zero rate', () => {
    // When / Then
    expect(describeStall({ chain: 'relay', peers: 2, bytesPerSecond: 0.4 })).toBe(
      'Connected to 2 computers for Polkadot, but no data is arriving yet.',
    );
  });

  it('As a user on an ordinary connection, I see the rate in kilobytes', () => {
    // When / Then
    expect(describeStall({ chain: 'relay', peers: 2, bytesPerSecond: 2048 })).toBe(
      'Fetching Polkadot from 2 computers at 2 kB/s. Slower than usual.',
    );
  });

  it('As a user just under the slow-load rate, I am still told the load is slow', () => {
    // When / Then
    expect(describeStall({ chain: 'bulletin', peers: 1, bytesPerSecond: SLOW_BYTES_PER_SECOND - 1024 })).toBe(
      'Fetching the app files from 1 computer at 127 kB/s. Slower than usual.',
    );
  });

  it('As a user on a fine connection, I see no warning while a chain takes its time', () => {
    // When / Then
    expect(describeStall({ chain: 'bulletin', peers: 1, bytesPerSecond: SLOW_BYTES_PER_SECOND })).toBeNull();
  });
});

describe('describeProgressStall', () => {
  it('As a user whose load is slow before any reading arrives, I am not told it is my connection', () => {
    // When / Then
    expect(describeProgressStall(null)).toBe('Still working. This is taking longer than usual.');
  });

  it('As a user whose load is busy without downloading, I am not told it is my connection', () => {
    // When / Then
    expect(describeProgressStall(0)).toBe('Still working. This is taking longer than usual.');
  });

  it('As a user on a fine connection, I see no warning while the bar waits', () => {
    // When / Then
    expect(describeProgressStall(2_097_152)).toBeNull();
  });

  it('As a user on a slow download, I see the real rate', () => {
    // When / Then
    expect(describeProgressStall(2048)).toBe(
      'Still downloading at 2 kB/s. That is slower than this app usually needs, so give it a moment.',
    );
  });
});
