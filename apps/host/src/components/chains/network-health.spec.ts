// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { healthWord } from './network-health.js';

describe('healthWord', () => {
  it('As the More menu, I name each verdict in one word', () => {
    // When / Then
    expect(healthWord('ok')).toBe('Connected');
    expect(healthWord('idle')).toBe('Syncing');
    expect(healthWord('warn')).toBe('Unstable');
    expect(healthWord('err')).toBe('Offline');
    expect(healthWord('quiet')).toBe('Not in use');
  });
});
