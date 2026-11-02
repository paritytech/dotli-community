// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { urlPillState, type UrlPillState } from './state/urlPillState.js';

/**
 * Keeps the build-time URL bar markup showing the url-pill store and returns the unsubscribe. Product strings go in as
 * text, never markup. Throws when `bar` lacks a part of the markup.
 */
export function bindUrlPill(bar: HTMLElement): () => void {
  const pill = findPart(bar, '#url-pill');
  const domain = findPart(bar, '#url-pill-domain');
  const tld = findPart(bar, '#url-pill-tld');
  function render(): void {
    const state = urlPillState.store.get();
    const text = getPillText(state);
    bar.hidden = state.kind === 'none';
    pill.toggleAttribute('data-localhost', state.kind === 'localhost');
    domain.textContent = text.domain;
    tld.textContent = text.tld;
  }
  render();
  return urlPillState.store.subscribe(render);
}

function getPillText(state: UrlPillState): { domain: string; tld: string } {
  switch (state.kind) {
    case 'none':
      return { domain: '', tld: '' };
    case 'localhost':
      return { domain: state.host, tld: '' };
    case 'product':
      return { domain: state.domain, tld: state.tld };
  }
}

function findPart(bar: HTMLElement, selector: string): HTMLElement {
  const element = bar.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`URL bar markup without ${selector}`);
  }
  return element;
}
