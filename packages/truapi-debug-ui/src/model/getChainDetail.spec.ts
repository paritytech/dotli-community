// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getChainDetail } from './getChainDetail.js';

describe('chain detail', () => {
  it('As a dotli developer, I select a chain response and it shows its summary and its decoded annotations', () => {
    // Given
    const payload = { tag: 'V1', value: { success: false, value: { reason: 'block not pinned' } } };

    // When
    const detail = getChainDetail('remote_chain_head_header_response', payload);

    // Then
    expect(detail?.summary).toBe('Header fetch failed: block not pinned.');
    expect(detail?.fields.map(field => [field.name, field.value])).toEqual([
      ['method', 'chainHead.header'],
      ['outcome', 'error: block not pinned'],
    ]);
  });
});
