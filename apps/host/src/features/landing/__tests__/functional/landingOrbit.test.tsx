// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing orbit's inner ring, drawn from the visitor's backend and the light client's peers once boot seeds the
// settings.

import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { getActiveChainRoles, getSettings, setSettings } from '@dotli/config';
import { must, resetAllStoresForTests } from '@dotli/shared/testing';
import { networkMonitorState } from '../../../network/index.js';
import { settingsState } from '../../../settings/index.js';
import { LandingOrbitIsland } from '../../LandingOrbitIsland.js';

let page: HTMLElement;
let unmount: (() => void) | null = null;

/** Mounts the island and seeds the settings, as hydration and boot do. */
function mountBooted(): void {
  unmount = render(() => <LandingOrbitIsland />, page);
  settingsState.init();
  flush();
}

function getInnerDots(): Element[] {
  return [...must(page.querySelector('[data-ring="inner"]'), 'inner ring').children];
}

function getPeerDots(): Element[] {
  return [...page.querySelectorAll('[data-kind="peer"]')];
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

describe('landing orbit', () => {
  it('As a visitor whose light client finds peers on two chains, I see one peer dot for each peer', () => {
    // Given
    mountBooted();
    const [first, second] = getActiveChainRoles();

    // When
    networkMonitorState.recordPeerCount(must(first, 'first chain').role, 2);
    networkMonitorState.recordPeerCount(must(second, 'second chain').role, 3);
    flush();

    // Then
    expect(getPeerDots()).toHaveLength(5);
  });

  it('As a visitor on trusted providers, I see the one server in the inner ring', () => {
    // Given
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));

    // When
    mountBooted();

    // Then
    expect(getInnerDots().map(dot => dot.getAttribute('data-kind'))).toEqual(['server']);
  });
});
