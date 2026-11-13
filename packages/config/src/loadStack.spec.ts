// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { loadStack } from './loadStack.js';
import { NETWORK_NAMES } from './networkNames.js';

describe('loadStack', () => {
  it("As a user on any network, my core boots from that network's signed stack, and only a .dot network may use reserved values", async () => {
    // Given every network the build knows

    // When each one's stack loads
    const stacks = await Promise.all(NETWORK_NAMES.map(loadStack));

    // Then each carries a signed link and its descriptor, and only pcf-devnet may use the dot TLD
    expect(
      stacks.map(({ pointer, descriptor, allowsReservedValues }) => ({
        signed: pointer.startsWith('polkadotapp://stack?key=0x'),
        hasDescriptor: descriptor.length > 0,
        allowsReservedValues,
      })),
    ).toEqual(
      NETWORK_NAMES.map(network => ({
        signed: true,
        hasDescriptor: true,
        allowsReservedValues: network === 'pcf-devnet',
      })),
    );
  });
});
