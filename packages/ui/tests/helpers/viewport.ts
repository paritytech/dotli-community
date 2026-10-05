// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, vi } from 'vitest';
import { PHONE_QUERY, resetPhoneViewport } from '../../src/phone-viewport.js';

// phone-viewport.ts keeps one MediaQueryList, so a stub dropped by
// `vi.unstubAllGlobals()` must not outlive its test.
afterEach(() => {
  resetPhoneViewport();
});

/**
 * A viewport as narrow as a phone's (`phone` true) or as wide as a desktop's,
 * for the code that reads PHONE_QUERY. Only that query is answered here: every
 * other one (the colour scheme, reduced motion) goes to the `matchMedia` in
 * place before, so a `stubColorScheme` stub keeps working. `set` resizes the
 * viewport across the phone width and notifies the phone query's `change`
 * listeners. Restored by `vi.unstubAllGlobals()`.
 */
export function stubPhoneViewport(initial: boolean): { set: (phone: boolean) => void } {
  let phone = initial;
  const listeners = new Set<(e: Event) => void>();
  const previous = window.matchMedia.bind(window);
  vi.stubGlobal('matchMedia', (query: string) => {
    if (query !== PHONE_QUERY) {
      return previous(query);
    }
    return {
      get matches() {
        return phone;
      },
      media: query,
      addEventListener: (_type: string, cb: (e: Event) => void) => {
        listeners.add(cb);
      },
      removeEventListener: (_type: string, cb: (e: Event) => void) => {
        listeners.delete(cb);
      },
    };
  });
  resetPhoneViewport();
  return {
    set: next => {
      phone = next;
      for (const cb of [...listeners]) {
        cb(new Event('change'));
      }
    },
  };
}

/**
 * Resize the viewport as a phone or a rotation does: the stylesheets' media
 * queries and `matchMedia` follow, and the phone query's listeners hear the
 * change. Happy DOM's window starts 1024 wide.
 */
export function setViewportWidth(width: number): void {
  (window as unknown as { happyDOM: { setViewport: (viewport: { width: number }) => void } }).happyDOM.setViewport({
    width,
  });
  // Happy DOM keeps an element's computed style until the DOM changes, not
  // on a resize. A stylesheet coming and going drops it.
  const style = document.createElement('style');
  document.head.append(style);
  style.remove();
}
