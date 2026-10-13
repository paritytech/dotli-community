// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The UrlPillShield island against the page's real stores: the url-pill store it shows and the topbar's layer tracker
// it provides. A missing provider would fail silently, so this pins the wiring. The view itself is tested by the
// UrlPillShield and VerificationShield story plays.

import { afterEach, describe, expect, it } from 'vitest';
import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { resetAllStoresForTests, untilDom } from '@dotli/shared/testing';
import { UrlPillShield } from '../../src/islands/UrlPillShield.js';
import { anyTopbarSurfaceOpen } from '../../src/state/topbar-surfaces.js';
import { setVerificationShieldState, showProductPill } from '../../src/state/url-pill.js';
import { byId } from '@dotli/ui/testing';

let unmount: (() => void) | undefined;

function tooltipOpen(): boolean {
  return document.getElementById('verification-tooltip')?.hasAttribute('data-open') ?? false;
}

function mountIsland(): void {
  const slot = document.createElement('div');
  document.body.append(slot);
  unmount = render(() => <UrlPillShield />, slot);
  flush();
}

afterEach(() => {
  unmount?.();
  unmount = undefined;
  resetAllStoresForTests();
  document.body.replaceChildren();
});

describe('UrlPillShield island', () => {
  it("As a dApp user, the shield shows the product's state, and its open explainer keeps the auto-hiding bar up", async () => {
    // Given
    showProductPill('app', '.dot.li');
    setVerificationShieldState('trusted');
    mountIsland();
    await untilDom(() => document.getElementById('verification-shield')?.dataset['state'] === 'trusted');

    // When: Enter or Space on the shield, a click of `detail` 0
    byId('verification-shield').click();

    // Then
    await untilDom(() => tooltipOpen());
    expect(anyTopbarSurfaceOpen()).toBe(true);

    // When
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    // Then
    await untilDom(() => !tooltipOpen());
    expect(anyTopbarSurfaceOpen()).toBe(false);
  });
});
