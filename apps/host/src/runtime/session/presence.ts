// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether some sign-in exists on the root domain, as a presence-only flag. Safari keeps the wallet and the paired
// session per origin, so this flag is how a page learns about a sign-out it never saw.

import { BASE_DOMAIN, isLocalhost } from '@dotli/config';
import { recordExpected, reportExpected, spans as S } from '@dotli/metrics';
import { listen, noop } from '@dotli/shared';
import { pageRole, sharesFlag } from '../page-role.js';
import { getSharedChannel, type SharedChannel } from '../shared-mode.js';
import { reportWalletFailure } from '../wallet-failure.js';

export type Presence = 'present' | 'absent' | 'unknown';

export interface SessionPresence {
  /** Reads the flag, probing once per page whether it can be read when it is not there. */
  read(): Promise<Presence>;
  /** Settles once the flag is written, at once for the cookie and when the request ends for the dev store. */
  set(): Promise<void>;
  clear(): Promise<void>;
  /**
   * Extends the flag's lifetime only if it is set at that moment, so a sign-out elsewhere is not undone.
   */
  renew(): Promise<void>;
}

/** The page's cookie string, injected so the logic runs without a DOM. */
export interface CookieJar {
  read(): string;
  write(cookie: string): void;
}

const NAME = 'has_session';
const PROBE_NAME = 'has_session_probe';
const MAX_AGE = 34_560_000;
const PROBE_MAX_AGE = 60;

function cookieString(name: string, domain: string, maxAge: number): string {
  return `${name}=1; Domain=${domain}; Path=/; Secure; SameSite=Lax; Max-Age=${String(maxAge)}`;
}

function hasCookie(jar: CookieJar, name: string): boolean {
  return jar.read().split('; ').includes(`${name}=1`);
}

export function createCookiePresence(jar: CookieJar, domain: string): SessionPresence {
  let cached: boolean | undefined;
  // An empty `document.cookie` reads the same blocked as absent, so one write and read-back tells them apart. A cookie
  // that is there was readable, so only a missing one needs it.
  const readable = (): boolean => {
    if (cached === undefined) {
      jar.write(cookieString(PROBE_NAME, domain, PROBE_MAX_AGE));
      cached = hasCookie(jar, PROBE_NAME);
      jar.write(cookieString(PROBE_NAME, domain, 0));
    }
    return cached;
  };
  const presenceNow = (): Presence => {
    if (hasCookie(jar, NAME)) {
      return 'present';
    }
    return readable() ? 'absent' : 'unknown';
  };
  // Each body runs in the caller's turn, so a clear lands before the caller moves on, and a jar that throws rejects.
  return {
    read: () =>
      new Promise(resolve => {
        resolve(presenceNow());
      }),
    set: () =>
      new Promise(resolve => {
        jar.write(cookieString(NAME, domain, MAX_AGE));
        resolve();
      }),
    clear: () =>
      new Promise(resolve => {
        jar.write(cookieString(NAME, domain, 0));
        resolve();
      }),
    // Checked and written in one synchronous turn, the narrowest gap a cookie leaves for a sign-out elsewhere.
    renew: () =>
      new Promise(resolve => {
        if (hasCookie(jar, NAME)) {
          jar.write(cookieString(NAME, domain, MAX_AGE));
        }
        resolve();
      }),
  };
}

const reportWriteFailure = (reason: 'set' | 'clear' | 'renew') => (error: unknown) => {
  reportWalletFailure(error, {
    what: `signed-in flag ${reason}`,
    step: `presence_${reason}`,
    reason,
    metric: S.SESSION_FLAG_WRITE,
  });
};

/**
 * The flag in the dev HTTP store under every local root, because Chromium rejects a cookie with `Domain=localhost`.
 * Where nothing serves that store, as in Docker or the release tarball on `localhost`, every read and write fails. That
 * is the environment's failure, so a write that fails is a breadcrumb and a count, not an issue.
 */
export function createStorePresence(channel: SharedChannel): SessionPresence {
  const unwritten = (op: 'set' | 'clear') => (error: unknown) => {
    reportExpected(error, {
      flow: 'wallet',
      step: `presence_${op}`,
      metric: S.SESSION_FLAG_WRITE,
      reason: op,
    });
  };
  return {
    read: () => channel.read(NAME).then(value => (value === null ? 'absent' : 'present')),
    set: () => channel.write(NAME, '1').catch(unwritten('set')),
    clear: () => channel.clear(NAME).catch(unwritten('clear')),
    // The dev store keeps the flag until it is deleted, so a flag still set needs nothing.
    renew: () => Promise.resolve(),
  };
}

const documentJar: CookieJar = {
  read: () => document.cookie,
  write: cookie => {
    document.cookie = cookie;
  },
};

/**
 * A page that keeps its sign-in in another site's partition, which no other page signs out, so its flag reads as
 * unknown and the restore rule never drops what it stored. Writing would only touch a flag that partition does not
 * share. Decided by the page's role, not by a failed probe.
 */
const unsharedPresence: SessionPresence = {
  read: () => Promise.resolve('unknown'),
  set: () => Promise.resolve(),
  clear: () => Promise.resolve(),
  renew: () => Promise.resolve(),
};

export interface PagePresenceDeps {
  /** Whether the page shares the root domain's flag. A preview its preview host frames does not. */
  shared: () => boolean;
  /** Served from a local root such as `localhost`, where the flag lives in the dev HTTP store. */
  localhost: boolean;
  channel: () => SharedChannel;
  jar: CookieJar;
  domain?: string;
}

/** Runs `call` in the caller's turn and answers with `fallback` for a throw or a rejection. */
function settled<T>(call: () => Promise<T>, fallback: (error: unknown) => T): Promise<T> {
  return new Promise<T>(resolve => {
    resolve(call());
  }).catch(fallback);
}

/**
 * The page's flag, built on first use, so creating it reads no page globals. It never rejects and records each failure
 * once. A read that fails is unknown, so a restore never fails on the flag, and an unreadable flag is the environment's
 * failure, so the miss is only a breadcrumb. A write that fails is reported and settles, so a caller that must store
 * nothing before the flag awaits it and any other leaves it. Each call reaches the flag in the caller's turn.
 */
export function createPagePresence(deps: PagePresenceDeps): SessionPresence {
  let inner: SessionPresence | undefined;
  const get = (): SessionPresence =>
    (inner ??= !deps.shared()
      ? unsharedPresence
      : deps.localhost
        ? createStorePresence(deps.channel())
        : createCookiePresence(deps.jar, deps.domain ?? BASE_DOMAIN));
  return {
    read: () =>
      settled(
        () => get().read(),
        (error): Presence => {
          recordExpected(error, { flow: 'wallet', step: 'presence_read' });
          return 'unknown';
        },
      ),
    set: () => settled(() => get().set(), reportWriteFailure('set')),
    clear: () => settled(() => get().clear(), reportWriteFailure('clear')),
    renew: () => settled(() => get().renew(), reportWriteFailure('renew')),
  };
}

/** The browser's cookie change events, naming each cookie set or deleted. */
export interface CookieChanges {
  subscribe(listener: (names: readonly string[]) => void): () => void;
}

/**
 * Calls `listener` each time the flag cookie is set or deleted, so an open page hears a sign-in or a sign-out made
 * elsewhere at once. Nothing without change events, where a page learns of it on load and when the user comes back.
 */
export function onCookieFlagChange(changes: CookieChanges | null, listener: () => void): () => void {
  if (changes === null) {
    return noop;
  }
  return changes.subscribe(names => {
    if (names.includes(NAME)) {
      listener();
    }
  });
}

/** Safari since 18.4 and every current Chromium and Firefox have them, on a secure page only. */
function documentCookieChanges(): CookieChanges | null {
  if (typeof cookieStore === 'undefined') {
    return null;
  }
  return {
    subscribe: listener =>
      listen(cookieStore, 'change', event => {
        listener([...event.changed, ...event.deleted].map(cookie => cookie.name ?? ''));
      }),
  };
}

/** The flag's own change events, where it is a cookie: none for the dev HTTP store or a role that shares no flag. */
export function onSessionFlagChange(listener: () => void): () => void {
  const cookie = sharesFlag(pageRole()) && !isLocalhost;
  return onCookieFlagChange(cookie ? documentCookieChanges() : null, listener);
}

/** The cookie on a real domain, the dev HTTP store on a local root, and none on a page whose role shares no flag. */
export const sessionPresence: SessionPresence = createPagePresence({
  shared: () => sharesFlag(pageRole()),
  localhost: isLocalhost,
  channel: getSharedChannel,
  jar: documentJar,
});
