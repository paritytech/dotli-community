// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { SANDBOX_CONTRACT_PARAMS } from '@dotli/sandbox-wire';

import { stripContractParams } from './stripContractParams.js';

describe('stripContractParams', () => {
  it("As a user, I open the app and it never sees the host's contract params, the tracking id among them", () => {
    // Given
    const href = `https://abc.app.dot.li/?${SANDBOX_CONTRACT_PARAMS.resolutionId}=r1&q=mine#top`;

    // When
    const cleaned = stripContractParams(href);

    // Then
    expect(cleaned).toBe('https://abc.app.dot.li/?q=mine#top');
  });

  it('As a user, I open a URL with only my own params and it comes back as it was', () => {
    // Given
    const href = 'https://abc.app.dot.li/a?q=1';

    // When
    const cleaned = stripContractParams(href);

    // Then
    expect(cleaned).toBe(href);
  });
});
