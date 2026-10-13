// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { decodeChainAnnotations, formatChainLabel } from './chain-decode.js';
import { chainDetail } from './detail-format.js';

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

  it('As a dotli developer, a selected chain response shows its summary and its decoded annotations', () => {
    // Given
    const payload = { tag: 'V1', value: { success: false, value: { reason: 'block not pinned' } } };

    // When
    const detail = chainDetail('remote_chain_head_header_response', payload);

    // Then
    expect(detail?.summary).toBe('Header fetch failed: block not pinned.');
    expect(detail?.fields.map(field => [field.name, field.value])).toEqual([
      ['method', 'chainHead.header'],
      ['outcome', 'error: block not pinned'],
    ]);
  });

  it('As a dotli developer, a message outside the chain calls keeps its raw tag', () => {
    // When
    const annotations = decodeChainAnnotations('system_handshake_request', { version: 1 });

    // Then
    expect(annotations).toBeNull();
  });
});
