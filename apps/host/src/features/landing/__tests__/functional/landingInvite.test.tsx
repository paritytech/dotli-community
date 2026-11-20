// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's invitation to the light client, shown from the visitor's backend once boot seeds the settings.

import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { getSettings, setSettings } from '@dotli/config';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { settingsState } from '../../../settings/index.js';
import { LandingInviteIsland } from '../../LandingInviteIsland.js';

let page: HTMLElement;
let unmount: (() => void) | null = null;

/** Mounts the island and seeds the settings, as hydration and boot do. */
function mountBooted(): void {
  unmount = render(() => <LandingInviteIsland />, page);
  settingsState.init();
  flush();
}

function findInvite(): Element | null {
  return page.querySelector('[data-testid="light-client-invite"]');
}

beforeEach(() => {
  page = document.createElement('div');
  document.body.append(page);
});

afterEach(() => {
  unmount?.();
  unmount = null;
  resetAllStoresForTests();
  document.body.innerHTML = '';
});

describe('landing invitation to the light client', () => {
  it('As a visitor on trusted providers, I am invited to switch to the light client', () => {
    // Given
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));

    // When
    mountBooted();

    // Then
    expect(findInvite()).not.toBeNull();
  });

  it('As a visitor on the light client, I am not invited to switch', () => {
    // When
    mountBooted();

    // Then
    expect(findInvite()).toBeNull();
  });
});
