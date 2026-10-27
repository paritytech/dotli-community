// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { decodeChainAnnotations } from './decodeChainAnnotations.js';
import { formatChainLabel } from './formatChainLabel.js';

const GENESIS = `0x${'ab'.repeat(32)}`;

describe('chain message decoding', () => {
  it('As a dotli developer, I read a chain message and it shows its decoded method label instead of the raw tag', () => {
    // Given
    const payload = { genesisHash: GENESIS, withRuntime: true };

    // When
    const annotations = decodeChainAnnotations('remote_chain_head_follow_start', payload);
    const label = annotations === null ? null : formatChainLabel(annotations);

    // Then
    expect(annotations).toEqual({ kind: 'follow-start', genesisHash: GENESIS });
    expect(label).toBe('chainHead.follow');
  });

  it('As a dotli developer, I read a message outside the chain calls and it keeps its raw tag', () => {
    // When
    const annotations = decodeChainAnnotations('system_handshake_request', { version: 1 });

    // Then
    expect(annotations).toBeNull();
  });
});
