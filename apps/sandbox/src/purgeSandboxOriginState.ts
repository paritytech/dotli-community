// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { OriginWipeError, wipeOriginStores, type OriginStores } from '@dotli/shared';
import { createReporter, defineCount } from '@dotli/metrics';

const report = createReporter({ flow: 'content' });

/**
 * Count. A full reset's wipe of the sandbox origin: `ok` once for a clean wipe, else one `error` per store it could
 * not wipe, with the store as the `reason`.
 */
const appOriginPurgeMetric = defineCount<'error' | 'ok'>('app.origin_purge');

/** The stores a product may leave in the sandbox origin. A store this browser lacks is `null`. */
export type SandboxOrigin = {
  /** The origin's local storage. Throws when the browser blocks storage, so it is read on use. */
  getLocalStorage: () => Pick<Storage, 'clear'>;
  /** The origin's session storage. Throws when the browser blocks storage, so it is read on use. */
  getSessionStorage: () => Pick<Storage, 'clear'>;
  document: Pick<Document, 'cookie'>;
  /** The page's path, since a product may have set a cookie on it. */
  pathname: string;
} & OriginStores;

/**
 * Wipes every store a product may leave in the sandbox origin. Best-effort, since a page cannot reach `HttpOnly`
 * cookies. The reset is opt-in, so a partial wipe is not fatal, and each store is wiped whatever happened to the one
 * before. Each store the browser refuses is counted as expected, and a clean purge is counted once. Rejects only with
 * an error the shared wipe throws that is not an `OriginWipeError`.
 */
export async function purgeSandboxOriginState(origin: SandboxOrigin): Promise<void> {
  const refusals: [store: string, error: unknown][] = [];
  try {
    await wipeOriginStores(origin);
  } catch (error) {
    if (!(error instanceof OriginWipeError)) {
      throw error;
    }
    refusals.push(...error.failures);
  }
  const wipes: [store: string, wipe: () => void][] = [
    [
      'local_storage',
      () => {
        origin.getLocalStorage().clear();
      },
    ],
    [
      'session_storage',
      () => {
        origin.getSessionStorage().clear();
      },
    ],
    [
      'cookies',
      () => {
        expireCookies(origin);
      },
    ],
  ];
  for (const [store, wipe] of wipes) {
    try {
      wipe();
    } catch (error) {
      refusals.push([store, error]);
    }
  }

  // The browser refusing a store is not a bug, but it explains a product that still sees its old state.
  for (const [store, error] of refusals) {
    report.expected(error, { step: 'origin_purge', metric: appOriginPurgeMetric, reason: store });
  }
  if (refusals.length === 0) {
    appOriginPurgeMetric.count({ outcome: 'ok' });
  }
}

/**
 * Expires each cookie the page can see on every path from the root to the page's own, since a cookie set without a path
 * lives on the page's directory.
 */
function expireCookies({ document, pathname }: Pick<SandboxOrigin, 'document' | 'pathname'>): void {
  const segments = pathname.split('/').filter(segment => segment !== '');
  // The page's own path too, as written, since a cookie set on a directory keeps its trailing slash.
  const paths = new Set([
    '/',
    ...segments.map((_segment, index) => `/${segments.slice(0, index + 1).join('/')}`),
    pathname,
  ]);
  for (const entry of document.cookie.split(';')) {
    const name = (entry.split('=')[0] ?? '').trim();
    if (name === '') {
      continue;
    }
    for (const path of paths) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}`;
    }
  }
}
