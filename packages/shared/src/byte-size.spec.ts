// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { formatRate, formatSize } from './byte-size.js';

describe('byte sizes', () => {
  it('As a user, I read a size under a kilobyte in bytes, so a small payload never reads as nothing', () => {
    // When
    const size = formatSize(512);

    // Then
    expect(size).toBe('512 B');
  });

  it('As a user, I read a size under a megabyte in whole kilobytes', () => {
    // When / Then
    expect(formatSize(2048)).toBe('2 kB');
    expect(formatSize(1_048_575)).toBe('1024 kB');
  });

  it('As a user, I read a size of a megabyte or more with one decimal', () => {
    // When / Then
    expect(formatSize(1_048_576)).toBe('1.0 MB');
    expect(formatSize(3_040_870)).toBe('2.9 MB');
  });

  it('As a user watching a slow download, I read a trickle in bytes a second, not as 0 kB/s', () => {
    // When / Then
    expect(formatRate(300)).toBe('300 B/s');
    expect(formatRate(40_000)).toBe('39 kB/s');
    expect(formatRate(2_516_582)).toBe('2.4 MB/s');
  });
});
