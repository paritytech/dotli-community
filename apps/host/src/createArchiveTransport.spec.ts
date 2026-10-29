// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createArchiveTransport } from './createArchiveTransport.js';

describe('the archive transport', () => {
  it.each(['smoldot-direct', 'smoldot-shared-worker'] as const)(
    "As a dotli developer on the %s light client, I open the Archive tab and it reads blocks from the host's sandbox relay",
    backend => {
      // Given
      const blockSource = vi.fn(() => Promise.resolve(new Uint8Array()));

      // When
      const transport = createArchiveTransport(backend, blockSource);

      // Then
      expect(transport).toEqual({ blockSource });
    },
  );

  it('As a dotli developer on rpc-gateway, I open the Archive tab and it reads from the IPFS gateway, as the sandbox reads it', () => {
    // When
    const transport = createArchiveTransport('rpc-gateway', () => Promise.resolve(new Uint8Array()));

    // Then
    expect(transport).toEqual({ gateway: true });
  });
});
