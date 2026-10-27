// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { formatArchiveSummary } from './formatArchiveSummary.js';

describe('archive summary', () => {
  it('As a dotli developer, I load an archive and its summary counts its files and sizes', () => {
    // Given
    const files = [
      { path: 'assets/app.js', bytes: new Uint8Array(5) },
      { path: 'index.html', bytes: new Uint8Array(11) },
    ];

    // When
    const summary = formatArchiveSummary({ status: 'loaded', files, total: 16 });

    // Then
    expect(summary).toBe('2 files · 16 B');
  });
});
