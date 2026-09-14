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
 * Opened without a version so the request adopts whatever schema the app
 * created. Naming one pins the probe to a number that
 * `packages/storage/src/db.ts` is free to bump, and a lower number fails
 * the open with `VersionError`, which reads here as "nothing cached".
 */
const cachedCidExists = (label: string): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const open = indexedDB.open("dotli");
    open.onsuccess = () => {
      const db = open.result;
      // `waitForCachedCid` calls this on a timer, so without the close a page
      // accumulates one handle per poll. Each of those blocks a schema upgrade
      // and the `deleteDatabase` sweep in `packages/ui/src/topbar.ts`, neither of
      // which any functional test reaches after a probe, so this is hygiene
      // rather than a fix for an observed failure.
      const done = (found: boolean): void => {
        db.close();
        resolve(found);
      };
      try {
        const tx = db.transaction("cids", "readonly");
        const req = tx.objectStore("cids").get(label);
        req.onsuccess = () => {
          done(req.result !== undefined);
        };
        req.onerror = () => {
          done(false);
        };
      } catch {
        done(false);
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
 *
 * Polls through `hasCachedCid` rather than `page.waitForFunction`. That
 * helper does not await an async predicate, so it reads the pending
 * Promise as a truthy result and returns on the first poll whatever the
 * cache holds.
 */
export async function waitForCachedCid(
  page: Page,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  if (await hasCachedCid(page, label)) {
    return;
  }
  while (Date.now() < deadline) {
    await page.waitForTimeout(200);
    if (await hasCachedCid(page, label)) {
      return;
    }
  }
  throw new Error(
    `[cache] no cached CID for ${label} within ${String(timeoutMs)}ms`,
  );
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
