// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { UrlPillShield } from '../../../src/components/shell/UrlPillShield.js';
import { setVerificationShieldState, showLocalhostPill, showProductPill } from '../../../src/state/url-pill.js';
import { renderComponent, resetStores, settle } from '../../helpers/solid.js';
import { byId } from '../../support.js';

afterEach(() => {
  // Before the page is cleared: the explainer is portalled into the body.
  cleanup();
  resetStores();
  document.body.replaceChildren();
});

describe('URL pill shield', () => {
  it('As a visitor of a product, the shield shows in the state the host set, from before or after it mounts', async () => {
    // Given
    showProductPill('app', '.dot.li');
    setVerificationShieldState('verified');

    // When
    renderComponent(UrlPillShield);
    await settle();

    // Then
    expect(byId('verification-shield').getAttribute('data-state')).toBe('verified');

    // When
    setVerificationShieldState('trusted');
    await settle();

    // Then
    expect(byId('verification-shield').getAttribute('data-state')).toBe('trusted');
  });

  it('As a developer on a localhost proxy, or before a product loads, there is no shield', async () => {
    // Given
    renderComponent(UrlPillShield);
    await settle();

    // Then
    expect(document.getElementById('verification-shield')).toBeNull();

    // When
    showLocalhostPill('localhost:3000');
    await settle();

    // Then
    expect(document.getElementById('verification-shield')).toBeNull();

    // When
    showProductPill('app', '.dot.li');
    await settle();

    // Then: the state is not known yet.
    expect(byId('verification-shield').hasAttribute('data-state')).toBe(false);
  });
});
