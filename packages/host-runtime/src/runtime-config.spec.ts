// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { getActiveServicesConfig, setNetworkOverride } from '@dotli/config';
import { createTruapiRuntimeConfig, labelToProductId } from './runtime-config.js';

describe('labelToProductId', () => {
  afterEach(() => {
    setNetworkOverride('paseo-next-v2');
  });

  it("As a dotli integrator, the host maps dotli labels to the active network's TLD", () => {
    // When / Then
    expect(labelToProductId('acme')).toBe('acme.paseo');
  });

  // A product id built with the wrong TLD hashes to a different dotNS node, so
  // the host would read an empty record instead of failing loudly.
  it('As a dotli integrator, the host maps the same label to .testnet on previewnet', () => {
    // Given
    setNetworkOverride('previewnet');

    // When / Then
    expect(labelToProductId('acme')).toBe('acme.testnet');
  });

  it('As a dotli integrator, the host keeps localhost labels stable', () => {
    // When / Then
    expect(labelToProductId('localhost:5174')).toBe('localhost:5174');
  });
});

describe('createTruapiRuntimeConfig', () => {
  it('As a dotli integrator, the host accepts an explicit product id for local previews', () => {
    // When / Then
    expect(createTruapiRuntimeConfig('localhost:3000', 'truapi-playground.dot').productId).toBe(
      'truapi-playground.dot',
    );
  });

  it('As a dotli integrator, the host passes the full host runtime contract to the WASM core', () => {
    // When / Then
    expect(createTruapiRuntimeConfig('acme')).toEqual({
      productId: 'acme.paseo',
      host: {
        name: 'Polkadot Web',
        icon: undefined,
        version: undefined,
      },
      platform: {
        type: expect.any(String) as unknown,
        version: undefined,
      },
      people: {
        genesisHash: getActiveServicesConfig().people.genesis,
      },
      bulletin: {
        genesisHash: getActiveServicesConfig().bulletin.genesis,
      },
      assetHub: {
        genesisHash: getActiveServicesConfig().assethub.genesis,
      },
      pairing: {
        deeplinkScheme: 'polkadotapp',
      },
    });
  });
});
