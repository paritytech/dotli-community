// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getOperatingSystem } from './getOperatingSystem.js';

describe('getOperatingSystem', () => {
  it.each([
    {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      system: 'iOS',
    },
    {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/147.0 Mobile Safari/537.36',
      system: 'Android',
    },
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/147.0', system: 'macOS' },
    { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0', system: 'Windows' },
    { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/147.0', system: 'Linux' },
    { userAgent: 'curl/8.7.1', system: 'Unknown' },
  ])('As a dotli integrator, I read the user agent of $system and get $system', ({ userAgent, system }) => {
    // Given a user agent of one system

    // When
    const read = getOperatingSystem(userAgent);

    // Then
    expect(read).toBe(system);
  });
});
