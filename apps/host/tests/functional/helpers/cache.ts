// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Probes for the dotli host caching layers.
 */

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
    const open = indexedDB.open("dotli", 1);
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
  await page.waitForFunction(cachedCidExists, label, {
    timeout: timeoutMs,
    polling: 200,
  });
}

/**
 * Install a per-frame counter for SW archive-cache lookups.
 *
 * Wraps `ServiceWorker.prototype.postMessage` so every call that carries
 * `{type:"SW_CACHE_LOOKUP_EVENT"}` (the message `getCachedArchive` sends
 * to the sandbox SW) bumps `window.__dotliArchiveCacheLookups`. The
 * patch lives on the prototype, so it covers any controller the page
 * later acquires. Must be called on the context before the first
 * navigation. The counter resets on every fresh document.
 */
export async function trackArchiveCacheLookups(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    let count = 0;
    const proto = (
      globalThis as { ServiceWorker?: { prototype: ServiceWorker } }
    ).ServiceWorker?.prototype as
      | (ServiceWorker & { postMessage: ServiceWorker["postMessage"] })
      | undefined;
    if (proto !== undefined && typeof proto.postMessage === "function") {
      const orig = proto.postMessage;
      proto.postMessage = function (
        this: ServiceWorker,
        message: unknown,
        transfer?: unknown,
      ) {
        const m = message as { type?: string } | null;
        if (m?.type === "SW_CACHE_LOOKUP_EVENT") {
          count++;
        }
        return (orig as (m: unknown, t?: unknown) => void).call(
          this,
          message,
          transfer,
        );
      } as typeof proto.postMessage;
    }
    Object.defineProperty(globalThis, "__dotliArchiveCacheLookups", {
      get() {
        return count;
      },
      configurable: true,
    });
  });
}

/** Lookup count observed in the sandbox frame on the current navigation. */
export async function sandboxArchiveCacheLookups(page: Page): Promise<number> {
  const frame = page.frames().find((f) => f.url().includes(".app.localhost"));
  if (frame === undefined) {
    return 0;
  }
  return frame.evaluate(
    () =>
      (globalThis as { __dotliArchiveCacheLookups?: number })
        .__dotliArchiveCacheLookups ?? 0,
  );
}
