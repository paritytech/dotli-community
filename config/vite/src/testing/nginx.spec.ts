// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readNginxHeaders } from './nginx.js';

describe('readNginxHeaders', () => {
  it('As a dotli developer, I read a location the file does not hold and am told, not handed no headers', () => {
    // Given a file whose location blocks do not include the one asked for
    const file = 'nginx/snippets/dotli-session-page.conf';

    // When
    const read = (): Record<string, string> => readNginxHeaders(file, { location: '/s/missing' });

    // Then
    expect(read).toThrow('/s/missing');
  });
});
