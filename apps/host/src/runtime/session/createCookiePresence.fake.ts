// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { CookieJar } from './createCookiePresence.js';

export type FakeCookieJar = {
  /** Every cookie string written, in order. */
  readonly written: string[];
  /** How many times the jar was read. */
  reads(): number;
} & CookieJar;

/** A jar that stores by name and honours `Max-Age=0`, and records every written string. */
export function createFakeCookieJar(): FakeCookieJar {
  const cookies = new Map<string, string>();
  const written: string[] = [];
  let reads = 0;
  return {
    written,
    reads: () => reads,
    read() {
      reads += 1;
      return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    write(cookie) {
      written.push(cookie);
      const [pair = '', ...attributes] = cookie.split('; ');
      const [name = '', value = ''] = pair.split('=');
      if (attributes.includes('Max-Age=0')) {
        cookies.delete(name);
      } else {
        cookies.set(name, value);
      }
    },
  };
}
