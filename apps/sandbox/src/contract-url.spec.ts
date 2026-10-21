// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { SANDBOX_CONTRACT_PARAMS } from '@dotli/sandbox-wire';

import { withoutContractParams } from './contract-url.js';

describe('withoutContractParams', () => {
  it("As a user, the app I open never sees the host's contract params, the tracking id among them", () => {
    // Given
    const href = `https://abc.app.dot.li/?${SANDBOX_CONTRACT_PARAMS.resolutionId}=r1&q=mine#top`;

    // When
    const cleaned = withoutContractParams(href);

    // Then
    expect(cleaned).toBe('https://abc.app.dot.li/?q=mine#top');
  });

  it('As a user, a URL with only my own params comes back as it was', () => {
    // Given
    const href = 'https://abc.app.dot.li/a?q=1';

    // When
    const cleaned = withoutContractParams(href);

    // Then
    expect(cleaned).toBe(href);
  });
});
