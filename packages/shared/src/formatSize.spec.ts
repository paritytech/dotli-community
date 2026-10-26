// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { formatSize } from './formatSize.js';

describe('formatSize', () => {
  it.each([
    { bytes: 512, size: '512 B', unit: 'in bytes under a kilobyte, so a small payload never reads as nothing' },
    { bytes: 2048, size: '2 kB', unit: 'in whole kilobytes under a megabyte' },
    { bytes: 1_048_575, size: '1024 kB', unit: 'in whole kilobytes under a megabyte' },
    { bytes: 1_048_576, size: '1.0 MB', unit: 'in megabytes with one decimal from a megabyte up' },
    { bytes: 3_040_870, size: '2.9 MB', unit: 'in megabytes with one decimal from a megabyte up' },
  ])('As a user, I read a size of $bytes bytes and see $size, $unit', ({ bytes, size }) => {
    // When
    const formatted = formatSize(bytes);

    // Then
    expect(formatted).toBe(size);
  });
});
