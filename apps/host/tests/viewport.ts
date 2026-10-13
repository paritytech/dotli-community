// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, vi } from 'vitest';
import { PHONE_QUERY, resetPhoneViewport } from '@dotli/ui-core/testing';

// ui-core's phone viewport keeps one MediaQueryList, so a stub dropped by `vi.unstubAllGlobals()` must not outlive its
// test.
afterEach(() => {
  resetPhoneViewport();
});

/**
 * Answers only PHONE_QUERY and passes other queries to the previous `matchMedia`, so a `stubColorScheme` stub keeps
 * working.
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
