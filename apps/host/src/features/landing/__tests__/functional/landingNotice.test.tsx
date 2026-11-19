// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing footer's test network notice, filled in from the visitor's settings once boot seeds them.

import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getNetwork, NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { settingsState } from '../../../settings/index.js';
import { LandingNoticeIsland } from '../../LandingNoticeIsland.js';

let notice: HTMLElement;
let unmount: (() => void) | null = null;

/** Mounts the island in the footer's notice element, as hydration does. */
function mount(props: Parameters<typeof LandingNoticeIsland>[0] = {}): void {
  unmount = render(() => <LandingNoticeIsland {...props} />, notice);
  flush();
}

beforeEach(() => {
  localStorage.clear();
  notice = document.createElement('p');
  document.body.append(notice);
});

afterEach(() => {
  unmount?.();
  unmount = null;
  resetAllStoresForTests();
  document.body.innerHTML = '';
});

describe('landing test network notice', () => {
  it('As a visitor whose settings have not booted, I see no test network notice', () => {
    // When
    mount();

    // Then
    expect(notice.textContent).toBe('');
  });

  it('As a visitor on a test network, I see the test network notice once my settings boot', () => {
    // Given
    mount();

    // When
    settingsState.init();
    flush();

    // Then
    expect(notice.textContent).not.toBe('');
  });

  it('As a visitor on a network whose tokens have real value, I see no test network notice once my settings boot', () => {
    // Given
    mount({ networks: { ...NETWORK_NAME_TO_SERVICES_CONFIG, [getNetwork()]: { testnet: false } } });

    // When
    settingsState.init();
    flush();

    // Then
    expect(notice.textContent).toBe('');
  });
});
