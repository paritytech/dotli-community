// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether some sign-in exists on the root domain, as a presence-only flag. Safari keeps the wallet and the paired
// session per origin, so this flag is how a page learns about a sign-out it never saw.

import { BASE_DOMAIN, isLocalhost } from '@dotli/config';
import { reportExpected, spans as S } from '@dotli/metrics';
import { listen } from '@dotli/shared';
import { pageRole, isFlagShared } from '../pageRole.js';
import { getSharedChannel, type SharedChannel } from '../sharedMode.js';
import { reportWalletFailure } from '../walletFailure.js';
import {
  createCookiePresence,
  listenForCookieFlagChange,
  type CookieChanges,
  type CookieJar,
} from './createCookiePresence.js';
import { createStorePresence, getFlagWriteReport, type FlagWrite } from './createStorePresence.js';
import type { Presence, SessionPresence } from './types.js';

type Params = {
  /** Whether the page shares the root domain's flag. A preview its preview host frames does not. */
  isShared: () => boolean;
  /** Served from a local root such as `localhost`, where the flag lives in the dev HTTP store. */
  localhost: boolean;
  /** The dev HTTP store the flag lives in on a local root. Reached on first use only. */
  channel: () => SharedChannel;
  /** The cookie jar the flag lives in on a real domain. */
  jar: CookieJar;
  /** The domain the flag cookie is set on. The root domain by default. */
  domain?: string;
};

const documentJar: CookieJar = {
  read: () => document.cookie,
  write(cookie) {
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

/**
 * The page's flag, built on first use, so creating it reads no page globals. It never rejects and records each failure
 * once. A read that fails is unknown, so a restore never fails on the flag, and an unreadable flag is the environment's
 * failure, so the miss is counted as expected. A write that fails is reported and settles, so awaiting a write never
 * rejects. Each call reaches the flag in the caller's turn.
 */
export function createPagePresence({
  isShared,
  localhost,
  channel,
  jar,
  domain = BASE_DOMAIN,
}: Params): SessionPresence {
  let inner: SessionPresence | undefined;

  function pickPresence(): SessionPresence {
    if (!isShared()) {
      return unsharedPresence;
    }
    if (localhost) {
      return createStorePresence(channel());
    }
    return createCookiePresence({ jar, domain });
  }

  function getPresence(): SessionPresence {
    inner ??= pickPresence();
    return inner;
  }

  return {
    read: () =>
      callSettled(
        () => getPresence().read(),
        (error): Presence => {
          reportExpected(error, { flow: 'wallet', step: 'presence_read', metric: S.SESSION_PRESENCE_READ });
          return 'unknown';
        },
      ),
    set: () =>
      callSettled(
        () => getPresence().set(),
        error => {
          reportWriteFailure(error, 'set');
        },
      ),
    clear: () =>
      callSettled(
        () => getPresence().clear(),
        error => {
          reportWriteFailure(error, 'clear');
        },
      ),
    renew: () =>
      callSettled(
        () => getPresence().renew(),
        error => {
          reportWriteFailure(error, 'renew');
        },
      ),
  };
}

/** The cookie on a real domain, the dev HTTP store on a local root, and none on a page whose role shares no flag. */
export const sessionPresence: SessionPresence = createPagePresence({
  isShared: () => isFlagShared(pageRole.get()),
  localhost: isLocalhost,
  channel: getSharedChannel,
  jar: documentJar,
});

/**
 * The flag's own change events, where it is a cookie: none for the dev HTTP store or a role that shares no flag.
 * Returns the unsubscribe.
 */
export function listenForSessionFlagChange(listener: () => void): () => void {
  const cookie = isFlagShared(pageRole.get()) && !isLocalhost;
  return listenForCookieFlagChange(cookie ? getDocumentCookieChanges() : null, listener);
}

function reportWriteFailure(error: unknown, write: FlagWrite): void {
  reportWalletFailure(error, { what: `signed-in flag ${write}`, ...getFlagWriteReport(write) });
}

/** Runs `call` in the caller's turn and answers with `fallback` for a throw or a rejection. */
function callSettled<T>(call: () => Promise<T>, fallback: (error: unknown) => T): Promise<T> {
  return new Promise<T>(resolve => {
    resolve(call());
  }).catch(fallback);
}

/** Safari since 18.4 and every current Chromium and Firefox have them, on a secure page only. */
function getDocumentCookieChanges(): CookieChanges | null {
  if (typeof cookieStore === 'undefined') {
    return null;
  }
  return {
    subscribe: listener =>
      listen({
        target: cookieStore,
        type: 'change',
        handler: event => {
          listener([...event.changed, ...event.deleted].map(cookie => cookie.name ?? ''));
        },
      }),
  };
}
