// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative-time.js';

const NOW = 1_700_000_000_000;

describe('relative time', () => {
  it('As a user, relative times read naturally', () => {
    // Then
    expect(relativeTime(NOW, NOW)).toBe('just now');
    expect(relativeTime(NOW - 60_000, NOW)).toBe('a min ago');
    expect(relativeTime(NOW - 3 * 60_000, NOW)).toBe('3 mins ago');
    expect(relativeTime(NOW - 60 * 60_000, NOW)).toBe('an hour ago');
    expect(relativeTime(NOW - 5 * 60 * 60_000, NOW)).toBe('5 hours ago');
    expect(relativeTime(NOW - 24 * 60 * 60_000, NOW)).toBe('yesterday');
    expect(relativeTime(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe('3 days ago');
  });
});
