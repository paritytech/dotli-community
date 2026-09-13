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

interface InstalledExecutableScope {
  label: string;
  network: string;
}

/**
 * Browser-side check for a cached app executable under a network-scoped label.
 */
const cachedInstalledExecutableExists = ({
  label,
  network,
}: InstalledExecutableScope): Promise<boolean> => {
  return new Promise<boolean>((resolve) => {
    const open = indexedDB.open("dotli-installed-executables", 1);
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction("installed_executables", "readonly");
        const req = tx
          .objectStore("installed_executables")
          .get([network, "app", label]);
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
export function hasCachedInstalledExecutable(
  page: Page,
  label: string,
  network = "paseo-next-v2",
): Promise<boolean> {
  return page.evaluate(cachedInstalledExecutableExists, { label, network });
}

/** Wait until the host commits the complete installed executable record. */
export async function waitForCachedInstalledExecutable(
  page: Page,
  label: string,
  timeoutMs: number,
  network = "paseo-next-v2",
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
