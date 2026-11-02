// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  getActiveCoreGatewayChains,
  getActiveGatewayChains,
  getActiveGatewaySupportedGenesisHashes,
  getActiveServicesConfig,
  getActiveSupportedGenesisHashes,
} from './activeNetwork.js';
import { setSettings } from './activeSettings.js';
import { NETWORK_NAME_TO_SERVICES_CONFIG } from './networkServices.js';
import { getSettings } from './settings.js';

const paseo = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'];

// The core set is wider than the advertised gateway set because it also carries host-owned Bulletin operations.
describe('gateway-supported chains (rpc-gateway mode)', () => {
  let clearOverride: () => void;

  beforeEach(() => {
    clearOverride = setSettings({ ...getSettings(), network: 'paseo-next-v2' });
  });

  afterEach(() => {
    clearOverride();
  });

  it('As a product, I ask for the gateway chains and am offered relay, Asset Hub and People', () => {
    // When
    const hashes = getActiveGatewaySupportedGenesisHashes();

    // Then
    expect(hashes.has(paseo.relay.genesis.toLowerCase())).toBe(true);
    expect(hashes.has(paseo.assethub.genesis.toLowerCase())).toBe(true);
    expect(hashes.has(paseo.people.genesis.toLowerCase())).toBe(true);
  });

  it('As a product, I ask for the gateway chains and am not offered the Bulletin chain', () => {
    // When
    const hashes = getActiveGatewaySupportedGenesisHashes();

    // Then
    expect(hashes.has(paseo.bulletin.genesis.toLowerCase())).toBe(false);
  });

  it('As a Rust core runtime, I can access Bulletin through the host gateway set', () => {
    // When
    const hashes = new Set(getActiveCoreGatewayChains().map(chain => chain.genesis.toLowerCase()));

    // Then
    expect(hashes.has(paseo.bulletin.genesis.toLowerCase())).toBe(true);
  });

  it('As a product on Trusted Providers, I am offered only chains with a configured RPC endpoint', () => {
    // Given
    const config = { ...getActiveServicesConfig(), people: { ...getActiveServicesConfig().people, rpcs: [] } };

    // When
    const chains = getActiveGatewayChains(config);

    // Then
    expect(chains.map(chain => chain.genesis)).toEqual([config.relay.genesis, config.assethub.genesis]);
  });

  it('As a product on Trusted Providers, I am offered no chain the light client set lacks', () => {
    // Given
    const full = getActiveSupportedGenesisHashes();

    // When
    const offered = [...getActiveGatewaySupportedGenesisHashes()];

    // Then
    expect(offered.filter(hash => !full.has(hash))).toEqual([]);
  });

  it('As a product on the light client, I am offered the Bulletin chain', () => {
    // When
    const hashes = getActiveSupportedGenesisHashes();

    // Then
    expect(hashes.has(paseo.bulletin.genesis.toLowerCase())).toBe(true);
  });
});

describe('getActiveSupportedGenesisHashes', () => {
  it('As a product on Paseo, I target an unknown genesis hash and it is not supported', () => {
    // Given
    onTestFinished(setSettings({ ...getSettings(), network: 'paseo-next-v2' }));

    // When
    const hashes = getActiveSupportedGenesisHashes();

    // Then
    expect(hashes.has('0xdeadbeef')).toBe(false);
  });
});
