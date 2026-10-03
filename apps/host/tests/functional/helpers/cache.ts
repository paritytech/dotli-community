// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Probes for the dotli host caching layers.
 */

import type { BrowserContext, Page } from '@playwright/test';

/** True if the host's main frame set the cold-path resolve mark. */
export function hostResolveStarted(page: Page): Promise<boolean> {
  return page.evaluate(() => performance.getEntriesByType('mark').some(m => m.name === 'dotli:resolve:start'));
}

interface InstalledExecutableScope {
  label: string;
  network: string;
}

/**
 * Browser-side check for a cached app executable under a network-scoped label.
 */
const cachedInstalledExecutableExists = ({ label, network }: InstalledExecutableScope): Promise<boolean> => {
  return new Promise<boolean>(resolve => {
    const open = indexedDB.open('dotli-installed-executables', 1);
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction('installed_executables', 'readonly');
        const req = tx.objectStore('installed_executables').get([network, 'app', label]);
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
};

/** Snapshot whether the host has a cached installed app executable. */
export function hasCachedInstalledExecutable(page: Page, label: string, network = 'paseo-next-v2'): Promise<boolean> {
  return page.evaluate(cachedInstalledExecutableExists, { label, network });
}

/** Wait until the host commits the complete installed executable record. */
export async function waitForCachedInstalledExecutable(
  page: Page,
  label: string,
  timeoutMs: number,
  network = 'paseo-next-v2',
): Promise<void> {
  await page.waitForFunction(
    cachedInstalledExecutableExists,
    { label, network },
    {
      timeout: timeoutMs,
      polling: 200,
    },
  );
}

/**
 * Count reads of the host's block cache, and how many of those reads found
 * a record.
 *
 * Wraps `IDBObjectStore.prototype.get` so every read of the `blocks` store
 * bumps `window.__dotliBlockCacheReads` in the frame that made it, and hooks
 * the returned request's `success` event to bump
 * `window.__dotliBlockCacheHits` when `result !== undefined`. The relay runs
 * in the host's main frame, so that is where the counts are read. Must be
 * called on the context before the first navigation. Both counters reset on
 * every fresh document.
 */
export async function trackBlockCacheReads(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    let reads = 0;
    let hits = 0;
    // get as a function-typed property, not a method: the patch calls
    // the original with the store it was invoked on.
    type Get = (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) => IDBRequest<unknown>;
    const proto = (globalThis as { IDBObjectStore?: { prototype: { get: Get } } }).IDBObjectStore?.prototype;
    if (proto !== undefined) {
      const orig = proto.get;
      proto.get = function (query) {
        if (this.name === 'blocks') {
          reads++;
          const request = orig.call(this, query);
          request.addEventListener('success', () => {
            if (request.result !== undefined) {
              hits++;
            }
          });
          return request;
        }
        return orig.call(this, query);
      };
    }
    Object.defineProperty(globalThis, '__dotliBlockCacheReads', {
      get() {
        return reads;
      },
      configurable: true,
    });
    Object.defineProperty(globalThis, '__dotliBlockCacheHits', {
      get() {
        return hits;
      },
      configurable: true,
    });
  });
}

/** Block cache reads the host made on the current navigation. */
export function hostBlockCacheReads(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as { __dotliBlockCacheReads?: number }).__dotliBlockCacheReads ?? 0);
}

/** Block cache reads that found a record, on the current navigation. */
export function hostBlockCacheHits(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as { __dotliBlockCacheHits?: number }).__dotliBlockCacheHits ?? 0);
}

/** How many blocks the host holds in its block cache. */
export function cachedBlockCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>(resolve => {
        const open = indexedDB.open('dotli');
        open.onsuccess = () => {
          const db = open.result;
          const finish = (count: number): void => {
            db.close();
            resolve(count);
          };
          try {
            const req = db.transaction('blocks', 'readonly').objectStore('blocks').count();
            req.onsuccess = () => {
              finish(req.result);
            };
            req.onerror = () => {
              finish(0);
            };
          } catch {
            finish(0);
          }
        };
        open.onerror = () => {
          resolve(0);
        };
      }),
  );
}
