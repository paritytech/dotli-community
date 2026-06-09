// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pins URL/navigation behaviour: deep-path/query/hash forwarding, host
 * URL-bar preservation across render and reload, sandbox URL hygiene
 * (host contract keys never reach the product), and validator/contract
 * side-effects.
 *
 * Apps are reached by subdomain only: http://acme.dot.li/foo?a=b#h
 *
 * Env overrides: COMBO_PORT, COMBO_TIMEOUT_MS.
 */

import { expect, type Page } from "@playwright/test";
import {
  assertNoContractKeys,
  getProductFrame,
  getProductLocation,
  waitForSandboxErrorPage,
} from "../product-frame";
import { test } from "./helpers/shared-mode-reset";
import { seedBackend as seedChainBackend } from "./fixtures/settings";

const LABEL = "host-playground";
const PORT = process.env.COMBO_PORT ?? "5173";
const TIMEOUT_MS = parseInt(process.env.COMBO_TIMEOUT_MS ?? "45000", 10);

const HOST_BY_LABEL = `http://${LABEL}.localhost:${PORT}`;

// Navigation behaviour is the same for every backend, so we pin
// `rpc-gateway` (fastest/least-flaky) to keep the suite deterministic.
async function seedBackend(page: Page): Promise<void> {
  await seedChainBackend(page, "rpc-gateway");
}

test.describe("URL parameters are forwarded into the product", () => {
  test("when I open http://<label>.dot.li/foo?a=b#h, I land on /foo?a=b#h inside the product", async ({
    page,
  }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/foo?a=b#h`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.pathname).toBe("/foo");
    expect(loc.search).toBe("?a=b");
    expect(loc.hash).toBe("#h");
  });

  test("when I open http://<label>.dot.li/foo%20bar, the percent-encoding survives into the product pathname", async ({
    page,
  }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/foo%20bar`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.pathname).toBe("/foo%20bar");
  });

  test("when I open http://<label>.dot.li/?a=1&a=2, both values reach the product", async ({
    page,
  }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?a=1&a=2`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(new URLSearchParams(loc.search).getAll("a")).toEqual(["1", "2"]);
  });

  test("when I open http://<label>.dot.li/?a=, the empty query value reaches the product", async ({
    page,
  }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?a=`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.search).toBe("?a=");
  });
});

test.describe("Host URL bar preserves the entered URL after render", () => {
  // `applyUrlSettings` canonicalises the URL on every load so non-default
  // settings axes (rpc-gateway here) get re-inserted. Assert the user's
  // own params survive, not that canonicalisation is a no-op.
  test("after the product renders from http://<label>.dot.li/foo?a=b#h, the URL bar still shows /foo?a=b#h", async ({
    page,
  }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/foo?a=b#h`);
    await getProductFrame(page, TIMEOUT_MS);

    // Then
    const url = new URL(page.url());
    expect(url.pathname).toBe("/foo");
    expect(url.searchParams.get("a")).toBe("b");
    expect(url.hash).toBe("#h");
  });
});

test.describe("Reloading the page preserves the URL", () => {
  test("when I reload http://<label>.dot.li/foo?a=b, the path and query survive the reload", async ({
    page,
  }) => {
    // Given
    await seedBackend(page);
    await page.goto(`${HOST_BY_LABEL}/foo?a=b`);
    await getProductFrame(page, TIMEOUT_MS);

    // When
    await page.reload();

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.pathname).toBe("/foo");
    expect(loc.search).toBe("?a=b");
    expect(new URL(page.url()).pathname).toBe("/foo");
  });
});

test.describe("Sandbox URL hygiene: host contract keys never reach the product", () => {
  test("with a cold cache, when the product loads, the host contract keys are not visible in the product's URL", async ({
    page,
  }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?a=b`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.search).toBe("?a=b");
    assertNoContractKeys(loc.search);
  });

  test("with a warm cache, when the product loads, the host contract keys are still not visible in the product's URL", async ({
    page,
  }) => {
    // Given
    await seedBackend(page);
    // First visit warms the IndexedDB CID cache.
    await page.goto(`${HOST_BY_LABEL}/?a=b`);
    await getProductFrame(page, TIMEOUT_MS);

    // When
    // Second visit takes the cache-hit code path in apps/host/src/main.ts.
    await page.goto(`${HOST_BY_LABEL}/?a=b`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.search).toBe("?a=b");
    assertNoContractKeys(loc.search);
  });
});

test.describe("Validator regression guards", () => {
  test("when the sandbox receives an unknown chainBackend value, the sandbox renders an error page instead of guessing a default", async ({
    browser,
  }) => {
    // Given
    const context = await browser.newContext({
      storageState: undefined,
      serviceWorkers: "allow",
    });
    await context.addInitScript(() => {
      localStorage.setItem("dotli:chain-backend", "rpc-gateway");
    });
    // Inject a bogus contract value into the sandbox frame's URL BEFORE its
    // main.ts runs. `route.continue({ url })` only changes the fetch URL.
    // The frame's window.location stays as the original, so the validator
    // still sees the host-written value. addInitScript runs in every newly
    // attached child frame before any of its own scripts, so a targeted
    // history.replaceState here is the only reliable way to corrupt the
    // sandbox URL the validator actually reads.
    await context.addInitScript(() => {
      if (!window.location.host.includes(".app.localhost")) return;
      const u = new URL(window.location.href);
      u.searchParams.set("chainBackend", "bogus");
      history.replaceState(null, "", u.toString());
    });
    const page = await context.newPage();

    try {
      // When
      await page.goto(`${HOST_BY_LABEL}/`);

      // Then
      const reason = await waitForSandboxErrorPage(page, TIMEOUT_MS);
      expect(reason).toContain("chainBackend");
      expect(reason).toContain("bogus");
    } finally {
      await context.close();
    }
  });

  test("when I open http://<label>.dot.li/?ref=42, the unknown key reaches the product and does not trigger the validator", async ({
    page,
  }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?ref=42`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    // The pre-PR validator would have rejected `ref` as an unknown contract
    // key and rendered the error page. Assert no error page is showing.
    const errorVisible = await page
      .locator(".error-page-title")
      .first()
      .isVisible()
      .catch(() => false);
    expect(errorVisible, "unexpected error page for user query key").toBe(
      false,
    );
    const loc = await getProductLocation(product);
    expect(new URLSearchParams(loc.search).get("ref")).toBe("42");
    assertNoContractKeys(loc.search);
  });

  test("when I open http://<label>.dot.li/?chainBackend=foo, the host's valid value wins and my value is dropped from the product's URL", async ({
    page,
  }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?chainBackend=foo`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    // Host's bridge.ts uses searchParams.set, which OVERWRITES any user-supplied
    // value. The validator then accepts the host's valid value, and the sandbox
    // strips the (overwritten) chainBackend before document.write. Net effect:
    // the user's `?chainBackend=foo` vanishes silently from the product's URL.
    // Pinning this so a future "passthrough user contract keys" change can't
    // land without revisiting the question.
    expect(new URLSearchParams(loc.search).has("chainBackend")).toBe(false);
    assertNoContractKeys(loc.search);
  });
});

test.describe("Sandbox side-effects from URL contract keys", () => {
  test("when I open http://<label>.dot.li/?fullReset=1, sandbox-origin IndexedDB is purged before the product loads", async ({
    browser,
  }) => {
    // Given
    const context = await browser.newContext({
      storageState: undefined,
      serviceWorkers: "allow",
    });
    await context.addInitScript(() => {
      localStorage.setItem("dotli:chain-backend", "rpc-gateway");
    });
    const page = await context.newPage();

    try {
      // Visit 1 (no fullReset): warm the sandbox so we have a Frame to plant
      // a marker DB into. Same sandbox origin (<label>.app.localhost:PORT) is used
      // for visit 2, so the marker should persist across navigations until the
      // purge wipes it.
      await page.goto(`${HOST_BY_LABEL}/`);
      let product = await getProductFrame(page, TIMEOUT_MS);

      const PURGE_MARKER_DB = "__nav-spec-fullreset-marker";
      await product.evaluate(async (dbName: string) => {
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open(dbName, 1);
          req.onupgradeneeded = () => {
            req.result.createObjectStore("k");
          };
          req.onsuccess = () => {
            const tx = req.result.transaction("k", "readwrite");
            tx.objectStore("k").put("alive", "marker");
            tx.oncomplete = () => {
              req.result.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error as Error);
          };
          req.onerror = () => reject(req.error as Error);
        });
      }, PURGE_MARKER_DB);

      // When
      // Visit 2: user-supplied `?fullReset=1` flows from getDeepPath into the
      // iframe URL, the validator accepts it, then purgeSandboxOriginState
      // fires. This is the documented footgun: anyone can wipe a visitor's
      // sandbox-origin state by linking `acme.dot.li?fullReset=1`.
      await page.goto(`${HOST_BY_LABEL}/?fullReset=1`);
      product = await getProductFrame(page, TIMEOUT_MS);

      // Then
      const dbNames = await product.evaluate(async () => {
        const dbs = await indexedDB.databases();
        return dbs
          .map((d) => d.name)
          .filter((n): n is string => typeof n === "string");
      });
      expect(dbNames).not.toContain(PURGE_MARKER_DB);
      // The contract key must not leak into the product's URL either.
      const loc = await getProductLocation(product);
      assertNoContractKeys(loc.search);
    } finally {
      await context.close();
    }
  });
});
