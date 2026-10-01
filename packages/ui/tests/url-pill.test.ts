// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's URL bar (url-pill.ts), bound over the markup
// apps/host/src/components/UrlPill.astro renders at build time.

import { afterEach, describe, expect, it } from 'vitest';
import { bindUrlPill } from '../src/url-pill.js';
import { resetUrlPill, showLocalhostPill, showProductPill } from '../src/state/url-pill.js';
import { byId } from './support.js';

let unbind: (() => void) | undefined;

/** The build-time URL bar, bound to the store. */
function bind(): HTMLElement {
  document.body.innerHTML = `
    <div class="topbar-url" id="topbar-url" hidden>
      <div class="topbar-url-pill" id="url-pill">
        <svg class="localhost-icon"></svg>
        <span class="topbar-url-text"><span class="dot-domain"></span><span class="dot-tld"></span></span>
      </div>
    </div>`;
  const bar = byId('topbar-url');
  unbind = bindUrlPill(bar);
  return bar;
}

function text(): string {
  return byId('topbar-url').querySelector('.topbar-url-text')?.textContent ?? '';
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
    expect(bar.querySelector('.dot-domain')?.textContent).toBe('early');
    expect(bar.querySelector('.dot-tld')?.textContent).toBe('.dot.li');
    expect(byId('url-pill').classList.contains('localhost-pill')).toBe(false);

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
    expect(byId('url-pill').classList.contains('localhost-pill')).toBe(true);
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
