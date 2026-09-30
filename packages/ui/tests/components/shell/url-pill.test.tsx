// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's URL bar: the host page's markup (apps/host/src/components/
// UrlPill.astro), which bindUrlPill (src/url-pill.ts) fills in from the
// url-pill store, and the shield island in it (UrlPillShield).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UrlPillShield } from '../../../src/components/shell/UrlPillShield.js';
import {
  resetUrlPill,
  setVerificationShieldState,
  showLocalhostPill,
  showProductPill,
  urlPillStore,
} from '../../../src/state/url-pill.js';
import { bindUrlPill } from '../../../src/url-pill.js';
import { setVerificationShieldState as setShieldStateReexport } from '../../../src/verification-shield.js';
import { renderComponent, resetStores, settle } from '../../helpers/solid.js';
import { byId, query } from '../../support.js';

// UrlPill.astro's build-time render, the shield island's element empty as
// the build renders it with no pill.
const URL_BAR = `<div class="topbar-url" id="topbar-url" hidden><div class="topbar-url-pill" id="url-pill"><astro-island></astro-island><svg class="localhost-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg><span class="topbar-url-text"><span class="dot-domain"></span><span class="dot-tld"></span></span></div></div>`;

let unbind: () => void;

beforeEach(() => {
  document.body.innerHTML = URL_BAR;
});

afterEach(() => {
  unbind();
  resetStores();
  document.body.replaceChildren();
});

function urlBar(): HTMLElement {
  return byId('topbar-url');
}

function pill(): HTMLElement {
  return byId('url-pill');
}

function text(selector: string): string | null {
  return query(pill(), selector).textContent;
}

function bind(): void {
  unbind = bindUrlPill(urlBar());
}

describe('URL bar', () => {
  it('As a visitor on the landing page, the URL bar stays hidden', () => {
    // When
    bind();

    // Then
    expect(urlBar().hidden).toBe(true);
    expect(text('.dot-domain')).toBe('');
  });

  it('As a developer on a localhost proxy, the pill shows my host with the terminal icon', () => {
    // Given
    bind();

    // When
    showLocalhostPill('localhost:3000');

    // Then
    expect(urlBar().hidden).toBe(false);
    expect(pill().classList.contains('localhost-pill')).toBe(true);
    expect(text('.dot-domain')).toBe('localhost:3000');
    expect(text('.dot-tld')).toBe('');
  });

  it('As a visitor of a product, the pill shows its domain and TLD, without the terminal icon', () => {
    // Given
    bind();

    // When
    showProductPill('app', '.dot.li');

    // Then
    expect(urlBar().hidden).toBe(false);
    expect(pill().classList.contains('localhost-pill')).toBe(false);
    expect(text('.dot-domain')).toBe('app');
    expect(text('.dot-tld')).toBe('.dot.li');
  });

  it('As a dotli user, a domain or host containing markup renders as text', () => {
    // Given
    bind();

    // When
    showProductPill('<b>x</b>', '<i>y</i>');

    // Then
    expect(pill().querySelector('b')).toBeNull();
    expect(pill().querySelector('i')).toBeNull();
    expect(text('.dot-domain')).toBe('<b>x</b>');
    expect(text('.dot-tld')).toBe('<i>y</i>');
  });

  it('As a dotli user, a pill written before the script runs shows once it does', () => {
    // Given: main.ts resolved the product first.
    showProductPill('app', '.dot.li');

    // When
    bind();

    // Then
    expect(urlBar().hidden).toBe(false);
    expect(text('.dot-domain')).toBe('app');
  });

  it('As a dotli user, resetting the pill hides the URL bar again', () => {
    // Given
    bind();
    showLocalhostPill('localhost:3000');

    // When
    resetUrlPill();

    // Then
    expect(urlBar().hidden).toBe(true);
    expect(pill().classList.contains('localhost-pill')).toBe(false);
    expect(text('.dot-domain')).toBe('');
  });

  it('As the host, a shield state set outside a product pill is ignored, and a new product pill starts without one', () => {
    // Given
    bind();

    // When
    setVerificationShieldState('verified');

    // Then
    expect(urlPillStore.get()).toEqual({ kind: 'none' });

    // When
    showLocalhostPill('localhost:3000');
    setVerificationShieldState('verified');

    // Then
    expect(urlPillStore.get()).toEqual({ kind: 'localhost', host: 'localhost:3000' });

    // When
    showProductPill('app', '.dot.li');
    setShieldStateReexport('trusted');
    showProductPill('other', '.dot.li');

    // Then
    expect(urlPillStore.get()).toEqual({ kind: 'product', domain: 'other', tld: '.dot.li', shield: null });
  });
});

describe('URL pill shield', () => {
  beforeEach(() => {
    bind();
  });

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
