// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { formatPayloadSummary } from './formatPayloadSummary.js';

describe('formatPayloadSummary()', () => {
  it('As a dotli developer, I see a bigint payload in the same form as a bigint field', () => {
    // When
    const summaries = [formatPayloadSummary(5n), formatPayloadSummary({ amount: 5n })];

    // Then
    expect(summaries).toEqual(['5n', 'amount=5n']);
  });
});
