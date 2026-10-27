// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { formatExportFilename } from './formatExportFilename.js';

describe('debug export file name', () => {
  it('As a dotli developer, I export the events and the file is named after the moment it was taken', () => {
    // When
    const filename = formatExportFilename(new Date(Date.UTC(2026, 8, 25, 10, 34, 56, 789)));

    // Then
    expect(filename).toBe('dotli-debug-2026-09-25T10-34-56.json');
  });
});
