// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { getTldSuffix, NETWORK_KEY, NetworkName, peekNetwork } from '../src/network.js';
import { parseSettingsFromSearch } from '../src/url-settings.js';

describe('peekNetwork', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('As a first-time visitor, the shell guesses the default network and stores nothing', () => {
    // When
    const network = peekNetwork(null);

    // Then
    expect(network).toBe(NetworkName.PASEO);
    expect(localStorage.getItem(NETWORK_KEY)).toBeNull();
  });

  it('As a returning visitor, the shell guesses the network I chose before', () => {
    // Given
    localStorage.setItem(NETWORK_KEY, NetworkName.PREVIEWNET);

    // When
    const network = peekNetwork(null);

    // Then
    expect(network).toBe(NetworkName.PREVIEWNET);
  });

  it('As a visitor following a shared link, the network in the link wins over my stored one', () => {
    // Given
    localStorage.setItem(NETWORK_KEY, NetworkName.PASEO);

    // When
    const network = peekNetwork(
      parseSettingsFromSearch(new URLSearchParams({ network: NetworkName.PREVIEWNET })).network,
    );

    // Then
    expect(network).toBe(NetworkName.PREVIEWNET);
    expect(getTldSuffix(network)).toBe('.testnet');
  });

  it('As a visitor following a link with an unknown network, the shell falls back to my stored one', () => {
    // Given
    localStorage.setItem(NETWORK_KEY, NetworkName.PREVIEWNET);

    // When
    const network = peekNetwork(parseSettingsFromSearch(new URLSearchParams({ network: 'nope' })).network);

    // Then
    expect(network).toBe(NetworkName.PREVIEWNET);
  });
});
