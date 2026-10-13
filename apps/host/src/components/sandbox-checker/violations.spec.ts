// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { appendViolation, clampPanelHeight, MAX_ENTRIES, violationFrom } from './violations.js';

const product = { name: 'product window' };
const now = (): number => 42;

describe('sandbox checker violations', () => {
  it('As a dotli developer, a violation from the product reads as its API and its details', () => {
    // When
    const violation = violationFrom(
      {
        source: product,
        data: { type: 'DOTLI_API_VIOLATION', api: 'localStorage.getItem', details: { key: 'x', n: 1 }, timestamp: 0 },
      },
      product,
      now,
    );

    // Then
    expect(violation).toEqual({ api: 'localStorage.getItem', details: 'key=x n=1', timestamp: 0 });
  });

  it('As a dotli developer, a violation without details or a time reads with none and the time it arrived', () => {
    // When
    const violation = violationFrom(
      { source: product, data: { type: 'DOTLI_API_VIOLATION', api: 'fetch' } },
      product,
      now,
    );

    // Then
    expect(violation).toEqual({ api: 'fetch', details: '', timestamp: 42 });
  });

  it('As a dotli developer, messages from other windows or of other types are ignored', () => {
    // Given
    const valid = { type: 'DOTLI_API_VIOLATION', api: 'x', details: {}, timestamp: 0 };

    // Then
    expect(violationFrom({ source: { name: 'the host' }, data: valid }, product, now)).toBeNull();
    expect(violationFrom({ source: null, data: valid }, product, now)).toBeNull();
    expect(violationFrom({ source: product, data: { ...valid, type: 'SOMETHING_ELSE' } }, product, now)).toBeNull();
    expect(violationFrom({ source: product, data: 'not an object' }, product, now)).toBeNull();
    expect(violationFrom({ source: product, data: null }, product, now)).toBeNull();
  });

  it('As a dotli developer, a looping product keeps only the newest 500 violations', () => {
    // Given
    const entries: string[] = [];

    // When
    for (let i = 0; i < 600; i++) {
      appendViolation(entries, `api${String(i)}`);
    }

    // Then
    expect(MAX_ENTRIES).toBe(500);
    expect(entries).toHaveLength(500);
    expect(entries[0]).toBe('api100');
    expect(entries[499]).toBe('api599');
  });

  it('As a dotli developer, dragging the handle sizes the panel within 40 px and 80 % of the viewport', () => {
    // Given a 768 px tall viewport

    // Then
    expect(clampPanelHeight(568, 768)).toBe(200);
    expect(clampPanelHeight(760, 768)).toBe(40);
    expect(clampPanelHeight(0, 768)).toBeCloseTo(614.4);
  });
});
