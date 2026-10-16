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

/** Keeps the build-time URL bar markup showing the url-pill store. Product strings go in as text, never markup. */
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
