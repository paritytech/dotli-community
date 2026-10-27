// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';
import { formatChainDisplay } from './formatChainDisplay.js';

describe('formatChainDisplay', () => {
  it("As a dotli developer, I read Paseo's chains in the debug panel and they are named after Paseo", () => {
    // Given
    const paseo = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'];

    // When
    const names = [paseo.relay, paseo.assethub, paseo.bulletin, paseo.people].map(chain =>
      formatChainDisplay(chain.genesis),
    );

    // Then
    expect(names).toEqual(['Paseo Relay', 'Paseo Hub', 'Paseo Storage', 'Paseo Identity']);
  });

  it("As a dotli developer, I read Previewnet's chains in the debug panel and they are named after Previewnet, not Paseo", () => {
    // Given
    const previewnet = NETWORK_NAME_TO_SERVICES_CONFIG.previewnet;

    // When
    const names = [previewnet.relay, previewnet.assethub, previewnet.bulletin, previewnet.people].map(chain =>
      formatChainDisplay(chain.genesis),
    );

    // Then
    expect(names).toEqual(['Previewnet Relay', 'Previewnet Hub', 'Previewnet Storage', 'Previewnet Identity']);
  });

  it('As a dotli developer, I read a chain no network names and it shows as its short hash', () => {
    // When
    const name = formatChainDisplay(`0x${'ab'.repeat(32)}`);

    // Then
    expect(name).toBe('0xababab…abab');
  });
});
