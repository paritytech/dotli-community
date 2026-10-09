// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

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
        tx.oncomplete = () => {
          open.result.close();
        };
        tx.onabort = () => {
          open.result.close();
          resolve(false);
        };
        const req = tx.objectStore('installed_executables').get([network, 'app', label]);
        req.onsuccess = () => {
          resolve(req.result !== undefined);
        };
        req.onerror = () => {
          resolve(false);
        };
      } catch {
        open.result.close();
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
  await expect
    .poll(() => hasCachedInstalledExecutable(page, label, network), {
      timeout: timeoutMs,
      intervals: [200],
    })
    .toBe(true);
}

/** Call before the first navigation. Counts are per document, read in the host's main frame where the relay runs. */
export async function trackBlockCacheReads(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    let reads = 0;
    let hits = 0;
    // A function-typed property, not a method, so the patch calls the original with the store it was invoked on.
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

export function hostBlockCacheReads(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as { __dotliBlockCacheReads?: number }).__dotliBlockCacheReads ?? 0);
}

export function hostBlockCacheHits(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as { __dotliBlockCacheHits?: number }).__dotliBlockCacheHits ?? 0);
}

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
