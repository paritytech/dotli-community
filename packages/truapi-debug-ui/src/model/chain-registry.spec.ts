// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { NETWORK_NAME_TO_SERVICES_CONFIG, NetworkName } from '@dotli/config';
import { formatChainDisplay } from './chain-registry.js';

describe('formatChainDisplay', () => {
  it("As a dotli developer reading the debug panel, I see Paseo's chains named after Paseo", () => {
    // Given
    const paseo = NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO];

    // When
    const names = [paseo.relay, paseo.assethub, paseo.bulletin, paseo.people].map(chain =>
      formatChainDisplay(chain.genesis),
    );

    // Then
    expect(names).toEqual(['Paseo Relay', 'Paseo Hub', 'Paseo Storage', 'Paseo Identity']);
  });

  it("As a dotli developer reading the debug panel, I see Previewnet's chains named after Previewnet, not Paseo", () => {
    // Given
    const previewnet = NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PREVIEWNET];

    // When
    const names = [previewnet.relay, previewnet.assethub, previewnet.bulletin, previewnet.people].map(chain =>
      formatChainDisplay(chain.genesis),
    );

    // Then
    expect(names).toEqual(['Previewnet Relay', 'Previewnet Hub', 'Previewnet Storage', 'Previewnet Identity']);
  });

  it('As a dotli developer reading the debug panel, I see a chain no network names as its short hash', () => {
    // When
    const name = formatChainDisplay(`0x${'ab'.repeat(32)}`);

    // Then
    expect(name).toBe('0xababab…abab');
  });
});
