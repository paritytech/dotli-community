// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureModeStorage } from './mode.js';
import { memoryModeStorage, type MemoryModeStorage } from './mode.fake.js';
import {
  applyNetworkOverrides,
  NETWORK_NAME_TO_SERVICES_CONFIG,
  NetworkName,
  getActiveSupportedGenesisHashes,
  getActiveCoreGatewayChains,
  getActiveGatewayChains,
  getActiveGatewaySupportedGenesisHashes,
  getTldSuffix,
  NETWORK_KEY,
  peekNetwork,
  setNetworkOverride,
} from './network.js';
import { parseSettingsFromSearch } from './url-settings.js';

const v2 = NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO];

// The core set is wider than the advertised gateway set because it also carries host-owned Bulletin operations.
describe('gateway-supported chains (rpc-gateway mode)', () => {
  let clearOverride: () => void;

  beforeEach(() => {
    clearOverride = setNetworkOverride(NetworkName.PASEO);
  });

  afterEach(() => {
    clearOverride();
  });

  it('As a product, the host advertises relay, Asset Hub, and People', () => {
    // When
    const hashes = getActiveGatewaySupportedGenesisHashes();

    // Then
    expect(hashes.has(v2.relay.genesis.toLowerCase())).toBe(true);
    expect(hashes.has(v2.assethub.genesis.toLowerCase())).toBe(true);
    expect(hashes.has(v2.people.genesis.toLowerCase())).toBe(true);
  });

  it('As a product, the host does not advertise the Bulletin chain', () => {
    // When
    const hashes = getActiveGatewaySupportedGenesisHashes();

    // Then
    expect(hashes.has(v2.bulletin.genesis.toLowerCase())).toBe(false);
  });

  it('As a Rust core runtime, I can access Bulletin through the host gateway set', () => {
    // When
    const hashes = new Set(getActiveCoreGatewayChains().map(chain => chain.genesis.toLowerCase()));

    // Then
    expect(hashes.has(v2.bulletin.genesis.toLowerCase())).toBe(true);
  });

  it('As a product on Trusted Providers, I am offered only chains with a configured RPC endpoint', () => {
    // When / Then
    for (const chain of getActiveGatewayChains()) {
      expect(chain.rpcs.length).toBeGreaterThan(0);
    }
  });

  it('As a product on Trusted Providers, I am offered no chain the light client set lacks', () => {
    // Given
    const full = getActiveSupportedGenesisHashes();

    // When / Then
    for (const hash of getActiveGatewaySupportedGenesisHashes()) {
      expect(full.has(hash)).toBe(true);
    }
  });

  it('As a product on the light client, I am offered the Bulletin chain', () => {
    // When / Then
    expect(getActiveSupportedGenesisHashes().has(v2.bulletin.genesis.toLowerCase())).toBe(true);
  });
});

describe('peekNetwork', () => {
  let storage: MemoryModeStorage;
  let restoreStorage: () => void;

  beforeEach(() => {
    storage = memoryModeStorage();
    restoreStorage = configureModeStorage(storage);
  });

  afterEach(() => {
    restoreStorage();
  });

  it('As a first-time visitor, the shell guesses the default network and stores nothing', () => {
    // When
    const network = peekNetwork(null);

    // Then
    expect(network).toBe(NetworkName.PASEO);
    expect(storage.dump()).toEqual({});
  });

  it('As a returning visitor, the shell guesses the network I chose before', () => {
    // Given
    storage.setItem(NETWORK_KEY, NetworkName.PREVIEWNET);

    // When
    const network = peekNetwork(null);

    // Then
    expect(network).toBe(NetworkName.PREVIEWNET);
  });

  it('As a visitor following a shared link, the network in the link wins over my stored one', () => {
    // Given
    storage.setItem(NETWORK_KEY, NetworkName.PASEO);

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
    storage.setItem(NETWORK_KEY, NetworkName.PREVIEWNET);

    // When
    const network = peekNetwork(parseSettingsFromSearch(new URLSearchParams({ network: 'nope' })).network);

    // Then
    expect(network).toBe(NetworkName.PREVIEWNET);
  });
});

// The protocol SharedWorker never sees the runtime config. `FixedServicesConfig` keeps it to fields no override can
// change, and these keep the merge true to that type.
describe('runtime network overrides', () => {
  it('As an operator, I point a network at my own nodes and its genesis hashes and dotNS contracts stay the built-in ones', () => {
    // Given
    const base = NETWORK_NAME_TO_SERVICES_CONFIG;

    // When
    const merged = applyNetworkOverrides(base, {
      [NetworkName.PASEO]: {
        label: 'Fork',
        relay: { rpcs: ['wss://relay.fork.example'] },
        assethub: { rpcs: ['wss://hub.fork.example'] },
        bulletin: { rpcs: ['wss://bulletin.fork.example'], ipfsGateways: ['https://ipfs.fork.example'] },
        people: { rpcs: ['wss://people.fork.example'] },
      },
    });

    // Then
    const fork = merged[NetworkName.PASEO];
    expect(fork.label).toBe('Fork');
    expect(fork.bulletin.ipfsGateways).toEqual(['https://ipfs.fork.example']);
    for (const role of ['relay', 'assethub', 'bulletin', 'people'] as const) {
      expect(fork[role].genesis).toBe(base[NetworkName.PASEO][role].genesis);
      expect(fork[role].blockTimeMs).toBe(base[NetworkName.PASEO][role].blockTimeMs);
    }
    expect(fork.dotns).toBe(base[NetworkName.PASEO].dotns);
  });

  it.each([
    ['a chain genesis hash', { relay: { genesis: '0x00' } }, 'relay.genesis'],
    ['a chain block time', { people: { blockTimeMs: 1 } }, 'people.blockTimeMs'],
    ['the Bulletin genesis hash', { bulletin: { genesis: '0x00' } }, 'bulletin.genesis'],
    ['the dotNS contracts', { dotns: {} }, 'dotns'],
  ])('As an operator, I try to override %s and the config is refused', (_field, patch, path) => {
    // When
    const merge = (): unknown => applyNetworkOverrides(NETWORK_NAME_TO_SERVICES_CONFIG, { [NetworkName.PASEO]: patch });

    // Then
    expect(merge).toThrow(`${path} is not overridable`);
  });
});
