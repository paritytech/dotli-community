// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's URL bar (url-pill.ts), bound over the markup
// apps/host/src/components/UrlPill.astro renders at build time.

import { afterEach, describe, expect, it } from 'vitest';
import { bindUrlPill } from '../src/url-pill.js';
import { resetUrlPill, showLocalhostPill, showProductPill } from '../src/state/url-pill.js';
import { byId, byTestId } from './support.js';

let unbind: (() => void) | undefined;

function bind(): HTMLElement {
  document.body.innerHTML = `
    <div id="topbar-url" hidden>
      <div id="url-pill">
        <svg></svg>
        <span data-testid="url-pill-text"><span id="url-pill-domain"></span><span id="url-pill-tld"></span></span>
      </div>
    </div>`;
  const bar = byId('topbar-url');
  unbind = bindUrlPill(bar);
  return bar;
}

function text(): string {
  return byTestId('url-pill-text', byId('topbar-url')).textContent;
}

afterEach(() => {
  unbind?.();
  unbind = undefined;
  resetUrlPill();
  document.body.innerHTML = '';
});

describe('URL bar', () => {
  it('As a visitor of the landing page, or before a product loads, the URL bar stays hidden', () => {
    // When
    const bar = bind();

    // Then
    expect(bar.hidden).toBe(true);
    expect(text()).toBe('');
  });

  it('As a visitor of a product, the URL bar shows its name and TLD, whenever the host sets them', () => {
    // Given
    showProductPill('early', '.dot.li');

    // When
    const bar = bind();

    // Then
    expect(bar.hidden).toBe(false);
    expect(byId('url-pill-domain').textContent).toBe('early');
    expect(byId('url-pill-tld').textContent).toBe('.dot.li');
    expect(byId('url-pill').hasAttribute('data-localhost')).toBe(false);

    // When
    showProductPill('later', '.dot.li');

    // Then
    expect(text()).toBe('later.dot.li');
  });

  it('As a developer on a local product, the URL bar shows its host as text, beside the terminal icon', () => {
    // Given
    bind();

    // When
    showLocalhostPill('<b>localhost:3000</b>');

    // Then
    expect(byId('topbar-url').hidden).toBe(false);
    expect(byId('url-pill').hasAttribute('data-localhost')).toBe(true);
    expect(text()).toBe('<b>localhost:3000</b>');
    expect(byId('url-pill').querySelector('b')).toBeNull();
  });

  it('As the shell, the URL bar stops following the store once unbound', () => {
    // Given
    bind();
    unbind?.();
    unbind = undefined;

    // When
    showProductPill('app', '.dot.li');

    // Then
    expect(byId('topbar-url').hidden).toBe(true);
  });
});
