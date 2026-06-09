// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Settings fixtures.
 */

import type { BrowserContext, Page } from "@playwright/test";

export const BACKENDS = [
  "smoldot-shared-worker",
  "smoldot-direct",
  "rpc-gateway",
] as const;

export type Backend = (typeof BACKENDS)[number];

export interface CacheSeed {
  skipCidCache: boolean;
  skipArchiveCache: boolean;
  skipWorkerCache: boolean;
}

export const CACHE_ENABLED: CacheSeed = {
  skipCidCache: false,
  skipArchiveCache: false,
  skipWorkerCache: false,
};

export const SKIP_CID_ONLY: CacheSeed = {
  skipCidCache: true,
  skipArchiveCache: false,
  skipWorkerCache: false,
};

export const SKIP_ARCHIVE_ONLY: CacheSeed = {
  skipCidCache: false,
  skipArchiveCache: true,
  skipWorkerCache: false,
};

export interface SettingsSeed {
  backend: Backend;
  cacheSeed?: CacheSeed;
}

/**
 * Seed backend and cache flags into localStorage on every navigation.
 *
 * `cacheSeed` writes only when the key is unset so a mid-test mutation
 * (page.evaluate) is not clobbered on subsequent navigations within
 * the same context.
 */
export async function seedSettings(
  context: BrowserContext,
  { backend, cacheSeed }: SettingsSeed,
): Promise<void> {
  await context.addInitScript(
    ({
      backend,
      cacheSeed,
    }: {
      backend: Backend;
      cacheSeed: CacheSeed | null;
    }) => {
      try {
        localStorage.setItem("dotli:chain-backend", backend);
        if (
          cacheSeed !== null &&
          localStorage.getItem("dotli:cache-settings") === null
        ) {
          localStorage.setItem(
            "dotli:cache-settings",
            JSON.stringify(cacheSeed),
          );
        }
      } catch (err) {
        console.warn("[seedSettings] localStorage seed failed", err);
      }
    },
    { backend, cacheSeed: cacheSeed ?? null },
  );
}

/**
 * Overwrite the cache-settings localStorage key in the live page.
 *
 * Used between cold and warm loads to flip a skip flag without
 * triggering the host shell's URL-change wipe-and-reload path.
 */
export async function updateCacheSettings(
  page: Page,
  seed: CacheSeed,
): Promise<void> {
  await page.evaluate((seed) => {
    localStorage.setItem("dotli:cache-settings", JSON.stringify(seed));
  }, seed);
}

/**
 * Seed `dotli:chain-backend` in localStorage. `onlyIfUnset` preserves the
 * key on retry-driven reloads where the in-page retry button has flipped
 * the backend. The default overwrite is right for fresh test starts.
 */
export async function seedBackend(
  page: Page,
  backend: Backend,
  options: { onlyIfUnset?: boolean } = {},
): Promise<void> {
  await page.addInitScript(
    ({ backend, onlyIfUnset }) => {
      try {
        if (
          onlyIfUnset &&
          localStorage.getItem("dotli:chain-backend") !== null
        ) {
          return;
        }
        localStorage.setItem("dotli:chain-backend", backend);
      } catch (err) {
        console.warn("[seedBackend] localStorage seed failed", err);
      }
    },
    { backend, onlyIfUnset: options.onlyIfUnset ?? false },
  );
}
