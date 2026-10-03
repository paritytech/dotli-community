// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { urlPillStore } from './state/url-pill.js';

function part(bar: HTMLElement, selector: string): HTMLElement {
  const el = bar.querySelector<HTMLElement>(selector);
  if (el === null) {
    throw new Error(`URL bar markup without ${selector}`);
  }
  return el;
}

/**
 * Keep the host page's URL bar (`#topbar-url`, rendered at build time by
 * apps/host/src/components/UrlPill.astro) showing the url-pill store, which
 * the host (main.ts) writes: hidden while there is no pill, a local
 * product's host (the pill's `data-localhost`), or a `.dot` product's label and
 * TLD. Product strings go in as text.
 * Returns the unbind.
 */
export function bindUrlPill(bar: HTMLElement): () => void {
  const pill = part(bar, '#url-pill');
  const domain = part(bar, '#url-pill-domain');
  const tld = part(bar, '#url-pill-tld');
  const render = (): void => {
    const state = urlPillStore.get();
    bar.hidden = state.kind === 'none';
    pill.toggleAttribute('data-localhost', state.kind === 'localhost');
    domain.textContent = state.kind === 'localhost' ? state.host : state.kind === 'product' ? state.domain : '';
    tld.textContent = state.kind === 'product' ? state.tld : '';
  };
  render();
  return urlPillStore.subscribe(render);
}
