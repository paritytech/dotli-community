// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { getNetwork, getSettings, setSettings } from '@dotli/config';
import { toProductId } from './createTruapiRuntimeConfig.js';

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
