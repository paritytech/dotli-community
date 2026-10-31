// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { OriginWipeError, wipeOriginStores, type OriginStores } from '@dotli/shared';
import { m, reportExpected, spans as S } from '@dotli/metrics';

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
  const purge = { refused: false };
  // The browser refusing a store is not a bug, but it explains a product that still sees its old state.
  function recordRefusal(store: string, error: unknown): void {
    reportExpected(error, { flow: 'content', step: 'origin_purge', metric: S.APP_ORIGIN_PURGE, reason: store });
    purge.refused = true;
  }
  async function wipe(store: string, run: () => unknown): Promise<void> {
    try {
      await run();
    } catch (error) {
      recordRefusal(store, error);
    }
  }

  try {
    await wipeOriginStores(origin);
  } catch (error) {
    if (!(error instanceof OriginWipeError)) {
      throw error;
    }
    for (const [part, cause] of error.failures) {
      recordRefusal(part, cause);
    }
  }
  await wipe('local_storage', () => {
    origin.getLocalStorage().clear();
  });
  await wipe('session_storage', () => {
    origin.getSessionStorage().clear();
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

  if (!purge.refused) {
    m.count(S.APP_ORIGIN_PURGE, { outcome: 'ok' });
  }
}
