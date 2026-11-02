// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getPageRenderState } from './context.js';
import type { RendererContext } from './types.js';

/** Returns a fresh page render's result, which the render state is keyed by. */
function createPageResult(): RendererContext['result'] {
  // Only the result's identity keys the state, so an empty object stands in for Astro's.
  return {} as RendererContext['result'];
}

describe('getPageRenderState', () => {
  it('As a dotli developer, I take render ids and claim style keys on one page and get s0 then s1, and each key is new only once', () => {
    // Given
    const result = createPageResult();

    // When
    const ids = [getPageRenderState(result).claimRenderId(), getPageRenderState(result).claimRenderId()];
    const claims = ['a.css', 'a.css', 'b.css'].map(key => getPageRenderState(result).claimStyle(key));

    // Then
    expect({ ids, claims }).toEqual({ ids: ['s0', 's1'], claims: [true, false, true] });
  });

  it('As a dotli developer, I render a second page and its ids start again at s0 with no style keys claimed', () => {
    // Given a first page that took an id and claimed a key
    const first = getPageRenderState(createPageResult());
    first.claimRenderId();
    first.claimStyle('a.css');

    // When
    const second = getPageRenderState(createPageResult());
    const id = second.claimRenderId();
    const claimed = second.claimStyle('a.css');

    // Then
    expect({ id, claimed }).toEqual({ id: 's0', claimed: true });
  });
});
