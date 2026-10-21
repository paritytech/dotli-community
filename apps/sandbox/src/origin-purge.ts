// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { OriginWipeError, wipeOriginStores, type OriginStores } from '@dotli/shared';
import { m, recordExpected, spans as S } from '@dotli/metrics';

/** The stores a product may leave in the sandbox origin. A store this browser lacks is `null`. */
export interface SandboxOrigin extends OriginStores {
  /** Read on use, since a browser that blocks storage throws on the read. */
  localStorage: () => Pick<Storage, 'clear'>;
  sessionStorage: () => Pick<Storage, 'clear'>;
  document: Pick<Document, 'cookie'>;
  /** The page's path, since a product may have set a cookie on it. */
  pathname: string;
}

/**
 * Best-effort, since a page cannot reach `HttpOnly` cookies. The reset is opt-in, so a partial wipe is not fatal, and
 * each store is wiped whatever happened to the one before.
 */
export async function purgeSandboxOriginState(origin: SandboxOrigin): Promise<void> {
  const failed: string[] = [];
  // The browser refusing a store is not a bug, but it explains a product that still sees its old state.
  const refused = (store: string, err: unknown): void => {
    recordExpected(err, { flow: 'content', step: 'origin_purge' });
    failed.push(store);
  };
  const wipe = async (store: string, run: () => unknown): Promise<void> => {
    try {
      await run();
    } catch (err) {
      refused(store, err);
    }
  };

  try {
    await wipeOriginStores(origin);
  } catch (err) {
    if (!(err instanceof OriginWipeError)) {
      throw err;
    }
    for (const [part, cause] of err.failures) {
      refused(part, cause);
    }
  }
  await wipe('local_storage', () => {
    origin.localStorage().clear();
  });
  await wipe('session_storage', () => {
    origin.sessionStorage().clear();
  });
  // A product may have set a cookie on either path.
  await wipe('cookies', () => {
    const expired = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
    for (const entry of origin.document.cookie.split(';')) {
      const name = (entry.split('=')[0] ?? '').trim();
      if (name === '') {
        continue;
      }
      origin.document.cookie = `${name}=; ${expired}; path=/`;
      origin.document.cookie = `${name}=; ${expired}; path=${origin.pathname}`;
    }
  });

  m.count(S.APP_ORIGIN_PURGE, failed.length === 0 ? { outcome: 'ok' } : { outcome: 'error', reason: failed.join(',') });
}
