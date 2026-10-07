// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';

/** A stand-in for the OS colour scheme, which happy-dom cannot evaluate. */
export function stubColorScheme(initial: 'light' | 'dark'): {
  set: (scheme: 'light' | 'dark') => void;
} {
  let scheme = initial;
  const listeners = new Set<(e: Event) => void>();
  const mql = {
    get matches() {
      return scheme === 'light';
    },
    media: '(prefers-color-scheme: light)',
    addEventListener: (_type: string, cb: (e: Event) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: (e: Event) => void) => {
      listeners.delete(cb);
    },
  };
  // Other queries do not match, as on a desktop-wide viewport.
  vi.stubGlobal('matchMedia', (query: string) =>
    query.includes('prefers-color-scheme')
      ? mql
      : {
          matches: false,
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        },
  );
  return {
    set: next => {
      scheme = next;
      for (const cb of listeners) {
        cb(new Event('change'));
      }
    },
  };
}
