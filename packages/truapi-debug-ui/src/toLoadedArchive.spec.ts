// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { toLoadedArchive } from './toLoadedArchive.js';

describe('archive file list', () => {
  it('As a dotli developer, I load an archive and the sidebar lists its files in order with their total size', () => {
    // Given
    const encoder = new TextEncoder();

    // When
    const archive = toLoadedArchive({
      'index.html': encoder.encode('<h1>hi</h1>'),
      'assets/app.js': encoder.encode('run()'),
    });

    // Then
    expect(archive.files.map(file => file.path)).toEqual(['assets/app.js', 'index.html']);
    expect(archive.total).toBe(16);
  });
});
