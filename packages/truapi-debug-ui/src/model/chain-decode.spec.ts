// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { decodeChainAnnotations, formatChainLabel } from './chain-decode.js';

const GENESIS = `0x${'ab'.repeat(32)}`;

describe('chain message decoding', () => {
  it('As a dotli developer, chain messages show their decoded method label instead of the raw tag', () => {
    // Given
    const payload = { genesisHash: GENESIS, withRuntime: true };

    // When
    const annotations = decodeChainAnnotations('remote_chain_head_follow_start', payload);

    // Then
    expect(annotations).toEqual({ kind: 'follow-start', genesisHash: GENESIS });
    expect(annotations === null ? null : formatChainLabel(annotations)).toBe('chainHead.follow');
  });

  it('As a dotli developer, a message outside the chain calls keeps its raw tag', () => {
    // When
    const annotations = decodeChainAnnotations('system_handshake_request', { version: 1 });

    // Then
    expect(annotations).toBeNull();
  });
});
