// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { parseIpfsResponse } from './parseIpfsResponse.js';

describe('parseIpfsResponse', () => {
  it('As a sandbox loading a product, I get a response that is not a CAR archive and serve it as the single index.html', async () => {
    // Given
    const html = new TextEncoder().encode('<html><body>Hello</body></html>');

    // When
    const result = await parseIpfsResponse(html);

    // Then
    expect(Object.keys(result)).toEqual(['index.html']);
    expect(new TextDecoder().decode(result['index.html'])).toBe('<html><body>Hello</body></html>');
  });
});
