// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseUiStateCache } from './parseUiStateCache.js';

describe('parseUiStateCache', () => {
  it('As a returning user, I see the account my cached UI state names before the session reports it', () => {
    // Given a cached connected state with its names
    const raw = JSON.stringify({ connected: true, publicKey: '0xaa', liteUsername: 'alice', extra: 1 });

    // When
    const uiState = parseUiStateCache(raw);

    // Then the known fields come back, and nothing else
    expect(uiState).toEqual({ connected: true, publicKey: '0xaa', liteUsername: 'alice' });
  });

  it.each([
    ['nothing cached', null],
    ['cached text that is not JSON', '{connected'],
    ['a cached JSON value that is not an object', '"connected"'],
    ['a cached disconnected state', JSON.stringify({ connected: false })],
    ['a cached name that is not text', JSON.stringify({ connected: true, fullUsername: 42 })],
  ])('As a returning user with %s, I see no cached account', (_case, raw) => {
    // Given the row's cached text, from the table

    // When
    const uiState = parseUiStateCache(raw);

    // Then
    expect(uiState).toBeNull();
  });
});
