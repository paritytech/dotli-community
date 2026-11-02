// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { err, ok } from './result.js';

describe('result', () => {
  it('As a caller, I wrap values with ok and err and tell them apart by their success, as scale-ts reads a Result', () => {
    // When
    const good = ok(7);
    const bad = err('nope');
    const empty = ok();

    // Then
    expect(good).toEqual({ success: true, value: 7 });
    expect(bad).toEqual({ success: false, value: 'nope' });
    expect(empty).toEqual({ success: true, value: undefined });
  });
});
