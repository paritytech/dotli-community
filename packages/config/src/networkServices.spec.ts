// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { NETWORK_NAME_TO_SERVICES_CONFIG } from './networkServices.js';

// Mirrors `DOTNS_TLDS` in truapi's `truapi-platform`.
const CORE_ACCEPTED_TLDS = ['dot', 'paseo', 'testnet'];

describe('NETWORK_NAME_TO_SERVICES_CONFIG', () => {
  it('As a dotli maintainer, I give every network a relay genesis as a 0x-prefixed hex string', () => {
    // When
    const geneses = Object.values(NETWORK_NAME_TO_SERVICES_CONFIG).map(config => config.relay.genesis);

    // Then
    for (const genesis of geneses) {
      expect(genesis).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('As a resolver on Paseo, I read the dotNS registry at a valid hex address', () => {
    // When
    const registry = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].dotns.DOTNS_REGISTRY;

    // Then
    expect(registry).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('As a resolver on Paseo, I read the dotNS content resolver at a valid hex address', () => {
    // When
    const resolver = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].dotns.DOTNS_CONTENT_RESOLVER;

    // Then
    expect(resolver).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it.each(Object.entries(NETWORK_NAME_TO_SERVICES_CONFIG))(
    'As a resolver on %s, I read dotNS ownership at slots of the right shape',
    (_network, config) => {
      // When the network's dotNS slots are read
      const slots = config.dotns.STORAGE_SLOTS;

      // Then each slot index is a non-negative integer and each hashed slot is 32 bytes of hex
      expect(Number.isInteger(slots.REGISTRY_PROTOCOL_REGISTRY)).toBe(true);
      expect(slots.REGISTRY_PROTOCOL_REGISTRY).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(slots.PROTOCOL_REGISTRY_ADDRESSES)).toBe(true);
      expect(slots.PROTOCOL_REGISTRY_ADDRESSES).toBeGreaterThanOrEqual(0);
      expect(slots.REGISTRAR_OWNERS).toMatch(/^0x[0-9a-f]{64}$/);
    },
  );

  it('As a dotli maintainer, I give every network a bare lowercase TLD and the truapi core accepts it', () => {
    // When
    const tlds = Object.entries(NETWORK_NAME_TO_SERVICES_CONFIG).map(([name, config]) => ({
      name,
      tld: config.dotns.TLD,
    }));

    // Then
    for (const { name, tld } of tlds) {
      expect(tld, `${name} TLD must be non-empty`).not.toBe('');
      expect(tld, `${name} TLD must be lowercase`).toBe(tld.toLowerCase());
      expect(tld, `${name} TLD must not carry a leading dot`).not.toMatch(/^\./);
      expect(CORE_ACCEPTED_TLDS, `${name} TLD ${tld} is not in the core's DOTNS_TLDS`).toContain(tld);
    }
  });

  it('As a visitor on Paseo, I fetch content from a first IPFS gateway on HTTPS', () => {
    // When
    const [gateway] = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'].bulletin.ipfsGateways;

    // Then
    expect(gateway).toMatch(/^https:\/\//);
  });
});
