// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';
import { PHONE_QUERY } from '../../src/phone-viewport.js';

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
  return {
    set: next => {
      phone = next;
      for (const cb of [...listeners]) {
        cb(new Event('change'));
      }
    },
  };
}
