// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { applyNetworkOverrides } from './applyNetworkOverrides.js';
import { NETWORK_NAME_TO_SERVICES_CONFIG } from './networkServices.js';

// The protocol SharedWorker never sees the runtime config. `FixedServicesConfig` keeps it to fields no override can
// change, and these keep the merge true to that type.
describe('applyNetworkOverrides', () => {
  it('As an operator, I point a network at my own nodes and its genesis hashes and dotNS contracts stay the built-in ones', () => {
    // Given
    const base = NETWORK_NAME_TO_SERVICES_CONFIG;

    // When
    const merged = applyNetworkOverrides({
      base,
      patches: {
        'paseo-next-v2': {
          label: 'Fork',
          relay: { rpcs: ['wss://relay.fork.example'] },
          assethub: { rpcs: ['wss://hub.fork.example'] },
          bulletin: { rpcs: ['wss://bulletin.fork.example'], ipfsGateways: ['https://ipfs.fork.example'] },
          people: { rpcs: ['wss://people.fork.example'] },
        },
      },
    });

    // Then
    const fork = merged['paseo-next-v2'];
    expect(fork.label).toBe('Fork');
    expect(fork.bulletin.ipfsGateways).toEqual(['https://ipfs.fork.example']);
    for (const role of ['relay', 'assethub', 'bulletin', 'people'] as const) {
      expect(fork[role].genesis).toBe(base['paseo-next-v2'][role].genesis);
      expect(fork[role].blockTimeMs).toBe(base['paseo-next-v2'][role].blockTimeMs);
    }
    expect(fork.dotns).toBe(base['paseo-next-v2'].dotns);
  });

  it('As an operator, I leave the runtime config off and get the built-in networks back', () => {
    // Given
    const base = NETWORK_NAME_TO_SERVICES_CONFIG;

    // When
    const merged = applyNetworkOverrides({ base, patches: undefined });

    // Then
    expect(merged).toBe(base);
  });

  it.each([
    ['a chain genesis hash', { relay: { genesis: '0x00' } }, 'relay.genesis'],
    ['a chain block time', { people: { blockTimeMs: 1 } }, 'people.blockTimeMs'],
    ['the Bulletin genesis hash', { bulletin: { genesis: '0x00' } }, 'bulletin.genesis'],
    ['the dotNS contracts', { dotns: {} }, 'dotns'],
  ])('As an operator, I try to override %s and the config is refused', (_field, patch, path) => {
    // When the override is merged
    const merge = (): unknown =>
      applyNetworkOverrides({ base: NETWORK_NAME_TO_SERVICES_CONFIG, patches: { 'paseo-next-v2': patch } });

    // Then the merge throws and names the field
    expect(merge).toThrow(`${path} is not overridable`);
  });

  it.each([
    ['a network patch that is an array', [], 'paseo-next-v2 must be an object, got an array'],
    ['a network patch that is null', null, 'paseo-next-v2 must be an object, got null'],
    ['a chain patch that is a string', { relay: 'wss://x' }, 'relay must be an object, got string'],
    [
      'endpoints that are a string',
      { relay: { rpcs: 'wss://x' } },
      'relay.rpcs must be an array of strings, got string',
    ],
    [
      'endpoints that hold a number',
      { relay: { rpcs: ['wss://x', 1] } },
      'relay.rpcs must be an array of strings, got an array with a non-string item',
    ],
    ['a label that is a number', { label: 1 }, 'label must be a string, got number'],
  ])('As an operator, I give %s and the config is refused with what it found', (_case, patch, message) => {
    // When the override is merged
    const merge = (): unknown =>
      applyNetworkOverrides({ base: NETWORK_NAME_TO_SERVICES_CONFIG, patches: { 'paseo-next-v2': patch } });

    // Then the merge throws and names the value it found
    expect(merge).toThrow(message);
  });

  it.each([
    ['an unknown network', 'kusama'],
    ['the prototype key', '__proto__'],
  ])('As an operator, I target %s and the config is refused', (_case, name) => {
    // Given a patch whose network is an own key, as JSON.parse makes even `__proto__`
    const patches = Object.fromEntries([[name, { label: 'Fork' }]]);

    // When the override is merged
    const merge = (): unknown => applyNetworkOverrides({ base: NETWORK_NAME_TO_SERVICES_CONFIG, patches });

    // Then the merge throws and names the network
    expect(merge).toThrow(`targets unknown network "${name}"`);
  });
});
