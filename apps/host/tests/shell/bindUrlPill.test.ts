// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's URL bar, bound over the markup its component renders at build time.

import { describe, expect, it, onTestFinished } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { bindUrlPill } from '../../src/bindUrlPill.js';
import { urlPillState } from '../../src/state/urlPillState.js';
import { byId, byTestId } from '@dotli/ui/testing';

describe('URL bar', () => {
  it('As a visitor of the landing page, I open it before any product loads and the URL bar stays hidden', () => {
    // When
    const { bar } = bindPill();

    // Then
    expect(bar.hidden).toBe(true);
    expect(readPillText()).toBe('');
  });

  it('As a visitor of a product, I open it and the URL bar shows its name and TLD whenever the host sets them', () => {
    // Given
    urlPillState.showProduct('early', '.dot.li');

    // When
    const { bar } = bindPill();

    // Then
    expect(bar.hidden).toBe(false);
    expect(byId('url-pill-domain').textContent).toBe('early');
    expect(byId('url-pill-tld').textContent).toBe('.dot.li');
    expect(byId('url-pill').hasAttribute('data-localhost')).toBe(false);

    // When
    urlPillState.showProduct('later', '.dot.li');

    // Then
    expect(readPillText()).toBe('later.dot.li');
  });

  it('As a developer on a local product, I open it and the URL bar shows its host as text beside the terminal icon', () => {
    // Given
    bindPill();

    // When
    urlPillState.showLocalhost('<b>localhost:3000</b>');

    // Then
    expect(byId('topbar-url').hidden).toBe(false);
    expect(byId('url-pill').hasAttribute('data-localhost')).toBe(true);
    expect(readPillText()).toBe('<b>localhost:3000</b>');
    expect(byId('url-pill').querySelector('b')).toBeNull();
  });

  it('As a developer, I unbind the URL bar and it stops following the store', () => {
    // Given
    const { unbind } = bindPill();

    // When the bar is unbound, and the store shows a product
    unbind();
    urlPillState.showProduct('app', '.dot.li');

    // Then
    expect(byId('topbar-url').hidden).toBe(true);
  });
});

/** Binds the URL bar over its markup and returns it with its unbind, which also runs when the case ends. */
function bindPill() {
  document.body.innerHTML = `
    <div id="topbar-url" hidden>
      <div id="url-pill">
        <svg></svg>
        <span data-testid="url-pill-text"><span id="url-pill-domain"></span><span id="url-pill-tld"></span></span>
      </div>
    </div>`;
  const bar = byId('topbar-url');
  const unbind = bindUrlPill(bar);
  onTestFinished(() => {
    unbind();
    resetAllStoresForTests();
    document.body.innerHTML = '';
  });
  return { bar, unbind };
}

function readPillText(): string {
  return byTestId('url-pill-text', byId('topbar-url')).textContent;
}
