// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Probes for the dotli host caching layers.
 */

import { expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

/** True if the host's main frame set the cold-path resolve mark. */
export function hostResolveStarted(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    performance
      .getEntriesByType("mark")
      .some((m) => m.name === "dotli:resolve:start"),
  );
}

/**
 * Browser-side check for a cached CID entry under `label`.
 *
 * Defined as a standalone function so the two Playwright entry points
 * below (`hasCachedCid` via `page.evaluate`, `waitForCachedCid` via
 * `page.waitForFunction`) share one IDB query body instead of two
 * copies that can drift.
 */
const cachedCidExists = (label: string): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const open = indexedDB.open("dotli");
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction("cids", "readonly");
        const req = tx.objectStore("cids").get(label);
        req.onsuccess = () => {
          resolve(req.result !== undefined);
        };
        req.onerror = () => {
          resolve(false);
        };
      } catch {
        resolve(false);
      }
    };
    open.onerror = () => {
      resolve(false);
    };
  });

/** Snapshot whether the host has a cached CID for `label`. */
export function hasCachedCid(page: Page, label: string): Promise<boolean> {
  return page.evaluate(cachedCidExists, label);
}

/**
 * Wait until the host has a cached CID for `label`.
 *
 * `setCachedCid` runs inside `requestIdleCallback` after
 * `dotli:app:end`, so a warm reload kicked off too quickly could
 * otherwise race the write.
 */
export async function waitForCachedCid(
  page: Page,
  label: string,
  timeoutMs: number,
): Promise<void> {
  await expect
    .poll(() => hasCachedCid(page, label), {
      timeout: timeoutMs,
      intervals: [200],
    })
    .toBe(true);
}

/**
 * Count reads of the host's block cache.
 *
 * Wraps `IDBObjectStore.prototype.get` so every read of the `blocks` store
 * bumps `window.__dotliBlockCacheReads` in the frame that made it. The relay
 * runs in the host's main frame, so that is where the count is read. Must be
 * called on the context before the first navigation. The counter resets on
 * every fresh document.
 */
export async function trackBlockCacheReads(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    let count = 0;
    // get as a function-typed property, not a method: the patch calls
    // the original with the store it was invoked on.
    type Get = (
      this: IDBObjectStore,
      query: IDBValidKey | IDBKeyRange,
    ) => IDBRequest<unknown>;
    const proto = (
      globalThis as { IDBObjectStore?: { prototype: { get: Get } } }
    ).IDBObjectStore?.prototype;
    if (proto !== undefined) {
      const orig = proto.get;
      proto.get = function (query) {
        if (this.name === "blocks") {
          count++;
        }
        return orig.call(this, query);
      };
    }
    Object.defineProperty(globalThis, "__dotliBlockCacheReads", {
      get() {
        return count;
      },
      configurable: true,
    });
  });
}

/** Block cache reads the host made on the current navigation. */
export function hostBlockCacheReads(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (globalThis as { __dotliBlockCacheReads?: number })
        .__dotliBlockCacheReads ?? 0,
  );
}

/** How many blocks the host holds in its block cache. */
export function cachedBlockCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open("dotli");
        open.onsuccess = () => {
          try {
            const req = open.result
              .transaction("blocks", "readonly")
              .objectStore("blocks")
              .count();
            req.onsuccess = () => {
              resolve(req.result);
            };
            req.onerror = () => {
              resolve(0);
            };
          } catch {
            resolve(0);
          }
        };
        open.onerror = () => {
          resolve(0);
        };
      }),
  );
}
