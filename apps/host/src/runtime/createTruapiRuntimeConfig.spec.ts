// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { getActiveServicesConfig, getNetwork, getSettings, setSettings } from '@dotli/config';
import { createTruapiRuntimeConfig, toProductId } from './createTruapiRuntimeConfig.js';

describe('toProductId', () => {
  it.each([
    { label: 'acme', network: undefined, productId: 'acme.paseo' },
    // A product id built with the wrong TLD hashes to a different dotNS node, so the host would read an empty record
    // instead of failing loudly.
    { label: 'acme', network: 'previewnet', productId: 'acme.testnet' },
    { label: 'localhost:5174', network: undefined, productId: 'localhost:5174' },
  ] as const)(
    "As a dotli integrator, I map the label $label on the $network network and get $productId with the network's TLD",
    ({ label, network, productId }) => {
      // Given the network the row names, the active one when it names none
      onTestFinished(setSettings({ ...getSettings(), network: network ?? getNetwork() }));

      // When
      const mapped = toProductId(label);

      // Then
      expect(mapped).toBe(productId);
    },
  );
});

describe('createTruapiRuntimeConfig', () => {
  it('As a dotli integrator, I build the config for a local preview with an explicit product id and get that id', () => {
    // Given a local preview's label and an explicit product id
    const label = 'localhost:3000';
    const productId = 'truapi-playground.dot';

    // When the config is built for them
    const config = createTruapiRuntimeConfig(label, { productId });

    // Then it carries the explicit id
    expect(config.productId).toBe('truapi-playground.dot');
  });

  it('As a dotli integrator, I build the config for a label and get the full host runtime contract for the WASM core', () => {
    // Given a label and no explicit product id
    const label = 'acme';

    // When the config is built for it
    const config = createTruapiRuntimeConfig(label);

    // Then it carries the full host runtime contract
    expect(config).toEqual({
      productId: 'acme.paseo',
      host: {
        name: 'Polkadot Web',
        icon: undefined,
        version: undefined,
      },
      platform: {
        // The asymmetric matcher is typed `any`, which lint bans inside an object literal.
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
