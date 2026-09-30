// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The URL pill's shield island (components/shell/UrlPillShield.tsx): the
// shield for a product pill, in the state the host set, and none otherwise.

import { afterEach, describe, expect, it } from 'vitest';
import { UrlPillShield } from '../../../src/components/shell/UrlPillShield.js';
import { setVerificationShieldState, showLocalhostPill, showProductPill } from '../../../src/state/url-pill.js';
import { renderComponent, resetStores, settle } from '../../helpers/solid.js';
import { byId } from '../../support.js';

afterEach(() => {
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
    expect(byId('verification-shield').classList.contains('verified')).toBe(true);

    // When
    setVerificationShieldState('trusted');
    await settle();

    // Then
    expect(byId('verification-shield').classList.contains('trusted')).toBe(true);
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
    expect(byId('verification-shield').classList.contains('verified')).toBe(false);
    expect(byId('verification-shield').classList.contains('trusted')).toBe(false);
  });
});
