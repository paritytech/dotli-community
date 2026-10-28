// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The signed-in flag as a cookie on the root domain, which every subdomain reads.

import { noop } from '@dotli/shared';
import type { Presence, SessionPresence } from './types.js';

/** The page's cookie string, injected so the logic runs without a DOM. */
export type CookieJar = {
  /** Answers the page's cookie string, which reads empty where the browser blocks cookies. May throw. */
  read(): string;
  /** Sets one cookie, or deletes it with `Max-Age=0`. May throw. */
  write(cookie: string): void;
};

/** The browser's cookie change events, naming each cookie set or deleted. */
export type CookieChanges = {
  /** Calls `listener` with the names of the cookies each change set or deleted. Returns the unsubscribe. */
  subscribe(listener: (names: readonly string[]) => void): () => void;
};

type Params = {
  /** Where the flag cookie is read and written. */
  jar: CookieJar;
  /** The domain the flag cookie is set on, which every subdomain of it reads. */
  domain: string;
};

type FormatCookieParams = {
  name: string;
  domain: string;
  /** Seconds the cookie lives, where zero deletes it. */
  maxAge: number;
};

/** The flag's name, the same wherever the flag is kept. */
export const SESSION_FLAG_NAME = 'has_session';
const PROBE_NAME = 'has_session_probe';
const MAX_AGE = 34_560_000;
const PROBE_MAX_AGE = 60;

/**
 * The flag as a cookie on `domain`. Each call reaches the jar in the caller's turn, and rejects when the jar throws.
 */
export function createCookiePresence({ jar, domain }: Params): SessionPresence {
  let cached: boolean | undefined;

  // An empty `document.cookie` reads the same blocked as absent, so one write and read-back tells them apart. A cookie
  // that is there was readable, so only a missing one needs it.
  function isReadable(): boolean {
    if (cached === undefined) {
      jar.write(formatCookie({ name: PROBE_NAME, domain, maxAge: PROBE_MAX_AGE }));
      cached = hasCookie(jar, PROBE_NAME);
      jar.write(formatCookie({ name: PROBE_NAME, domain, maxAge: 0 }));
    }
    return cached;
  }

  function readPresence(): Presence {
    if (hasCookie(jar, SESSION_FLAG_NAME)) {
      return 'present';
    }
    return isReadable() ? 'absent' : 'unknown';
  }

  // Each body runs in the caller's turn, so a clear lands before the caller moves on, and a jar that throws rejects.
  return {
    read: () =>
      new Promise(resolve => {
        resolve(readPresence());
      }),
    set: () =>
      new Promise(resolve => {
        jar.write(formatCookie({ name: SESSION_FLAG_NAME, domain, maxAge: MAX_AGE }));
        resolve();
      }),
    clear: () =>
      new Promise(resolve => {
        jar.write(formatCookie({ name: SESSION_FLAG_NAME, domain, maxAge: 0 }));
        resolve();
      }),
    // Checked and written in one synchronous turn, the narrowest gap a cookie leaves for a sign-out elsewhere.
    renew: () =>
      new Promise(resolve => {
        if (hasCookie(jar, SESSION_FLAG_NAME)) {
          jar.write(formatCookie({ name: SESSION_FLAG_NAME, domain, maxAge: MAX_AGE }));
        }
        resolve();
      }),
  };
}

/**
 * Calls `listener` each time the flag cookie is set or deleted, so an open page hears a sign-in or a sign-out made
 * elsewhere at once. Nothing without change events, where a page learns of it on load and when the user comes back.
 * Returns the unsubscribe.
 */
export function listenForCookieFlagChange(changes: CookieChanges | null, listener: () => void): () => void {
  if (changes === null) {
    return noop;
  }
  return changes.subscribe(names => {
    if (names.includes(SESSION_FLAG_NAME)) {
      listener();
    }
  });
}

function formatCookie({ name, domain, maxAge }: FormatCookieParams): string {
  return `${name}=1; Domain=${domain}; Path=/; Secure; SameSite=Lax; Max-Age=${String(maxAge)}`;
}

function hasCookie(jar: CookieJar, name: string): boolean {
  return jar.read().split('; ').includes(`${name}=1`);
}
