// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  isNameListReadDetail,
  isNameListSyncSummary,
  type NameListReadDetail,
  type NameListSyncSummary,
} from './nameListTimeline.js';

const SUMMARY: NameListSyncSummary = {
  outcome: 'ok',
  reason: null,
  backend: 'rpc-gateway',
  start: 'cold',
  stores: 3,
  entries: 5,
  labels: 2,
  apps: 1,
  reads: 3,
};

const DETAIL: NameListReadDetail = { kind: 'new_labels', outcome: 'ok', items: 2, found: 5 };

describe('isNameListSyncSummary', () => {
  it('As a perf script, I read back a whole end mark summary and it passes as one', () => {
    // Given
    const value: unknown = { ...SUMMARY };

    // When
    const passes = isNameListSyncSummary(value);

    // Then
    expect(passes).toBe(true);
  });

  it.each([
    ['an unknown backend', { ...SUMMARY, backend: 'carrier-pigeon' }],
    ['an unknown start', { ...SUMMARY, start: 'warm' }],
    ['a text store count', { ...SUMMARY, stores: '3' }],
    ['no backend', withoutField(SUMMARY, 'backend')],
    ['no start', withoutField(SUMMARY, 'start')],
    ['no store count', withoutField(SUMMARY, 'stores')],
  ])('As a perf script, I read back a summary with %s and it is refused', (_case, value) => {
    // Given: a summary with one field missing or of the wrong type, from the table

    // When
    const passes = isNameListSyncSummary(value);

    // Then
    expect(passes).toBe(false);
  });
});

describe('isNameListReadDetail', () => {
  it('As a perf script, I read back a whole read detail and it passes as one', () => {
    // Given
    const value: unknown = { ...DETAIL };

    // When
    const passes = isNameListReadDetail(value);

    // Then
    expect(passes).toBe(true);
  });

  it.each([
    ['an unknown outcome', { ...DETAIL, outcome: 'maybe' }],
    ['a null item count', { ...DETAIL, items: null }],
    ['a text found count', { ...DETAIL, found: '5' }],
    ['no outcome', withoutField(DETAIL, 'outcome')],
    ['no item count', withoutField(DETAIL, 'items')],
    ['no found count', withoutField(DETAIL, 'found')],
  ])('As a perf script, I read back a read detail with %s and it is refused', (_case, value) => {
    // Given: a read detail with one field missing or of the wrong type, from the table

    // When
    const passes = isNameListReadDetail(value);

    // Then
    expect(passes).toBe(false);
  });
});

function withoutField<Value extends object>(value: Value, field: keyof Value & string): unknown {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}
