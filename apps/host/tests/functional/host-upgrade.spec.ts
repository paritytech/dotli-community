// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const LEGACY_HTML = `<!doctype html>
<html><body><h1 id="legacy-host">Cached contract-v4 host</h1>
<script>
  navigator.serviceWorker.register('/host-sw.js');
</script></body></html>`;

// This deliberately has neither the new contract-query responder nor a
// controllerchange reload handler: already-cached hosts cannot gain either.
const LEGACY_WORKER = `
self.addEventListener('install', event => {
  event.waitUntil(caches.open('legacy-host-shell').then(cache => cache.add('/')));
});
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open('legacy-host-shell').then(cache => cache.match('/')));
  }
});
`;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveUpgrade(initial: "legacy" | "current") {
  // Fail before launching the fixture if the production build is missing.
  const [html, worker] = await Promise.all([
    readFile(resolve(DIST, "index.html")),
    readFile(resolve(DIST, "host-sw.js"), "utf8"),
  ]);
  let currentHtml = initial === "current";
  let currentWorker = initial === "current";
  let release = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Service-Worker-Allowed", "/");
      if (pathname === "/host-sw.js") {
        response.setHeader("Content-Type", MIME[".js"]!);
        // A byte-only release marker creates a genuine browser SW update
        // without copying, patching, or substituting the generated worker.
        response.end(
          currentWorker
            ? `${worker}\n// test release ${release}\n`
            : LEGACY_WORKER,
        );
        return;
      }
      if (pathname === "/" || pathname === "/index.html") {
        response.setHeader("Content-Type", MIME[".html"]!);
        response.end(currentHtml ? html : LEGACY_HTML);
        return;
      }
      if (pathname === "/dotli-network.js") {
        response.setHeader("Content-Type", MIME[".js"]!);
        response.end("window.__DOTLI_NETWORK__ = {};\n");
        return;
      }
      const path = resolve(DIST, `.${decodeURIComponent(pathname)}`);
      if (!path.startsWith(`${resolve(DIST)}${sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const bytes = await readFile(path);
      response.setHeader(
        "Content-Type",
        MIME[extname(path)] ?? "application/octet-stream",
      );
      response.end(bytes);
    })().catch((error: unknown) => {
      response.writeHead(404).end(String(error));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP listener");
  }
  return {
    origin: `http://localhost:${address.port}`,
    publishHtml() {
      currentHtml = true;
    },
    publishWorker() {
      currentWorker = true;
      release += 1;
    },
    async close() {
      const closed = Promise.withResolvers<void>();
      server.close((error) =>
        error ? closed.reject(error) : closed.resolve(),
      );
      server.closeAllConnections();
      await closed.promise;
    },
  };
}

async function seedUserData(page: Page) {
  await page.evaluate(async () => {
    localStorage.setItem("dotli-theme", "dark");
    localStorage.setItem("upgrade-user-setting", "keep my settings");
    const opened = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open("upgrade-user-data", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records");
    request.onsuccess = () => opened.resolve(request.result);
    request.onerror = () => opened.reject(request.error);
    const db = await opened.promise;
    const written = Promise.withResolvers<void>();
    const transaction = db.transaction("records", "readwrite");
    transaction
      .objectStore("records")
      .put({ message: "keep my saved record" }, "saved");
    transaction.oncomplete = () => written.resolve();
    transaction.onerror = () => written.reject(transaction.error);
    transaction.onabort = () => written.reject(transaction.error);
    await written.promise;
    db.close();
    const cache = await caches.open("upgrade-product-data");
    await cache.put("/saved-product", new Response("keep my product cache"));
  });
}

async function expectUserData(page: Page) {
  const saved = await page.evaluate(async () => {
    const opened = Promise.withResolvers<IDBDatabase>();
    const openRequest = indexedDB.open("upgrade-user-data", 1);
    openRequest.onsuccess = () => opened.resolve(openRequest.result);
    openRequest.onerror = () => opened.reject(openRequest.error);
    const db = await opened.promise;
    try {
      const savedRecord = Promise.withResolvers<unknown>();
      const request = db
        .transaction("records")
        .objectStore("records")
        .get("saved");
      request.onsuccess = () => savedRecord.resolve(request.result);
      request.onerror = () => savedRecord.reject(request.error);
      const record = await savedRecord.promise;
      return {
        theme: localStorage.getItem("dotli-theme"),
        setting: localStorage.getItem("upgrade-user-setting"),
        record,
        product: await (await caches.match("/saved-product"))?.text(),
      };
    } finally {
      db.close();
    }
  });
  expect(saved).toEqual({
    theme: "dark",
    setting: "keep my settings",
    record: { message: "keep my saved record" },
    product: "keep my product cache",
  });
}

async function updateWorker(page: Page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    // Return before activation can replace this execution context.
    void registration.update();
  });
}

test.describe("host service worker contract upgrades", () => {
  test.setTimeout(60_000);

  test("replaces a cache-first legacy host automatically without erasing user data", async ({
    browser,
  }) => {
    const fixture = await serveUpgrade("legacy");
    const context = await browser.newContext({ serviceWorkers: "allow" });
    try {
      // Real landing code, but no external chain, protocol host, or analytics
      // dependency. SW precache requests are served by the isolated HTTP server.
      await context.route("**/*", (route) => {
        return new URL(route.request().url()).origin === fixture.origin
          ? route.continue()
          : route.abort();
      });
      const page = await context.newPage();
      const url = `${fixture.origin}/?upgrade=legacy#saved-location`;
      await page.goto(url);
      await page.waitForFunction(
        () => navigator.serviceWorker.controller !== null,
      );
      await expect(page.locator("#legacy-host")).toBeVisible();
      await seedUserData(page);

      // New HTML on the network alone cannot repair a cache-first old host.
      // Keep the old worker endpoint until this ordinary reload proves it.
      fixture.publishHtml();
      const oldReload = await page.reload();
      expect(oldReload?.fromServiceWorker()).toBe(true);
      await expect(page.locator("#legacy-host")).toBeVisible();
      await expectUserData(page);
      let navigations = 0;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });

      fixture.publishWorker();
      await updateWorker(page);
      await expect(page.locator(".landing")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("#legacy-host")).toHaveCount(0);
      expect(page.url()).toBe(url);
      expect(navigations).toBe(1);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const registration = await navigator.serviceWorker.ready;
            return {
              active: registration.active?.state,
              waiting: registration.waiting !== null,
              controlled: navigator.serviceWorker.controller !== null,
            };
          }),
        )
        .toEqual({ active: "activated", waiting: false, controlled: true });
      await expectUserData(page);
    } finally {
      await context.close();
      await fixture.close();
    }
  });

  test("keeps a compatible update waiting until the user applies it", async ({
    browser,
  }) => {
    const fixture = await serveUpgrade("current");
    const context = await browser.newContext({ serviceWorkers: "allow" });
    try {
      await context.route("**/*", (route) => {
        return new URL(route.request().url()).origin === fixture.origin
          ? route.continue()
          : route.abort();
      });
      const page = await context.newPage();
      let navigations = 0;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });
      await page.goto(fixture.origin);
      await page.evaluate(() =>
        navigator.serviceWorker.ready.then(() => undefined),
      );
      await expect(page.locator(".landing")).toBeVisible();
      expect(navigations).toBe(1); // Fresh installation must not reload the page.
      await page.reload(); // Begin the update with a controlled, current host.
      await page.waitForFunction(
        () => navigator.serviceWorker.controller !== null,
      );
      await seedUserData(page);
      const beforeUpdate = navigations;
      await page.evaluate(() => {
        document.documentElement.dataset.contractQueries = "0";
        navigator.serviceWorker.addEventListener("message", (event) => {
          if (event.data?.type === "dotli:host-contract-version") {
            const root = document.documentElement;
            root.dataset.contractQueries = String(
              Number(root.dataset.contractQueries) + 1,
            );
          }
        });
      });

      fixture.publishWorker();
      await updateWorker(page);
      const reload = page.getByRole("button", { name: "Reload", exact: true });
      await expect(reload).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() =>
          page.evaluate(() =>
            Number(document.documentElement.dataset.contractQueries),
          ),
        )
        .toBeGreaterThan(0);
      // Observe longer than the contract-query timeout. A momentary waiting
      // state before a late skipWaiting call is not a successful prompt update.
      await page.waitForTimeout(3_500);
      expect(navigations).toBe(beforeUpdate);
      expect(
        await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          return registration.waiting?.state;
        }),
      ).toBe("installed");
      await expectUserData(page);

      await Promise.all([
        page.waitForEvent(
          "framenavigated",
          (frame) => frame === page.mainFrame(),
        ),
        reload.click(),
      ]);
      await expect(page.locator(".landing")).toBeVisible();
      expect(navigations).toBe(beforeUpdate + 1);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const registration = await navigator.serviceWorker.ready;
            return (
              registration.waiting === null &&
              registration.active?.state === "activated"
            );
          }),
        )
        .toBe(true);
      await expectUserData(page);
    } finally {
      await context.close();
      await fixture.close();
    }
  });
});
