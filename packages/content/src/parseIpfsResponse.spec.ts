// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import * as CarBufferWriter from '@ipld/car/buffer-writer';
import { CID } from 'multiformats/cid';
import { describe, it, expect } from 'vitest';
import { parseIpfsResponse } from './parseIpfsResponse.js';
import { createUnixFsDirectory } from './testing/createUnixFsDirectory.js';

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

  it('As a sandbox loading a product, I get a CAR archive holding a 30 MiB block and read the file from it', async () => {
    // Given
    const size = 30 * 1024 * 1024;
    const { root, blocks } = createUnixFsDirectory({ 'index.html': 'a'.repeat(size) });
    const writer = CarBufferWriter.createWriter(new ArrayBuffer(size + 1024 * 1024), {
      roots: [root],
      maxAllowedSectionSize: Infinity,
    });
    for (const [cid, bytes] of blocks) {
      writer.write({ cid: CID.parse(cid), bytes });
    }
    const car = writer.close({ resize: true });

    // When
    const result = await parseIpfsResponse(car, { expectedRoot: root });

    // Then
    expect(result['index.html']?.length).toBe(size);
  });
});
