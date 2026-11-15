// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { summariseChainMessage } from './summariseChainMessage.js';

describe('summariseChainMessage()', () => {
  it('As a dotli developer, I select a header response with no header bytes and its size reads unknown', () => {
    // When
    const summary = summariseChainMessage(
      { kind: 'head-header-response', outcome: 'ok' },
      { tag: 'V1', value: { success: true } },
    );

    // Then
    expect(summary).toBe('Header returned (? bytes).');
  });
});
