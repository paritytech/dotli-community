// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { HOST_ERRORS } from "../../src/errors";
import { test } from "./helpers/shared-mode-reset";
import { findAppFrame } from "../product-frame";
import { seedBackend, type Backend } from "./fixtures/settings";

const DOMAIN = process.env.COMBO_DOMAIN ?? "host-playground";
const PORT = process.env.COMBO_PORT ?? "5173";
const HOST_URL = `http://${DOMAIN}.localhost:${PORT}/`;

const RETRY_LABEL_FROM_SMOLDOT = "Try Trusted Providers";

// Preserve the post-retry backend that the in-page button just flipped.
async function setBackend(page: Page, backend: Backend): Promise<void> {
  await seedBackend(page, backend, { onlyIfUnset: true });
}

/**
 * Replace the protocol iframe document with a mock that runs a provided script.
 * Lets each test simulate ready / init-failed / fatal / response envelopes
 * without running the real smoldot pipeline.
 */
async function mockProtocolIframe(page: Page, script: string): Promise<void> {
  await page.route("**", async (route) => {
    const isProtocolDoc =
      route.request().url().includes(`host.localhost:${PORT}`) &&
      route.request().resourceType() === "document";
    if (!isProtocolDoc) {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<!DOCTYPE html><html><body><script>${script}</script></body></html>`,
    });
  });
}

const READY = `window.parent.postMessage({namespace:"dotli:protocol",kind:"ready"},"*");`;

// Post init-failed AFTER the iframe's load event fires, then retry with
// exponential backoff until the parent acks via `resetProtocolFrameState` (which
// blanks the iframe). A single fixed delay races the parent's `ensureProtocolFrame`
// resolver-registration window. Retries cover the worst case where the first
// post lands before any waiter is queued.
const initFailed = (message: string): string => `
  window.addEventListener("load", function() {
    var msg = {
      namespace: "dotli:protocol",
      kind: "init-failed",
      message: ${JSON.stringify(message)},
    };
    var delay = 20;
    var attempts = 0;
    function post() {
      if (attempts++ >= 12) return;
      try { window.parent.postMessage(msg, "*"); } catch (e) { return; }
      delay = Math.min(delay * 2, 500);
      setTimeout(post, delay);
    }
    post();
  });
`;

const fatalOnResolve = (message: string): string => `
  ${READY}
  window.addEventListener("message", function(e) {
    if (e.data && e.data.namespace === "dotli:protocol" && e.data.method === "resolveDotName") {
      window.parent.postMessage({
        namespace: "dotli:protocol",
        kind: "fatal",
        message: ${JSON.stringify(message)},
      }, "*");
    }
  });
`;

const errorResolveResponse = (error: string, delayMs = 0): string => `
  ${READY}
  window.addEventListener("message", function(e) {
    if (e.data && e.data.namespace === "dotli:protocol" && e.data.method === "resolveDotName") {
      var id = e.data.id;
      setTimeout(function() {
        window.parent.postMessage({
          namespace: "dotli:protocol",
          kind: "response",
          id: id,
          ok: false,
          error: ${JSON.stringify(error)},
        }, "*");
      }, ${String(delayMs)});
    }
  });
`;

const nullResolveResponse = `
  ${READY}
  window.addEventListener("message", function(e) {
    if (e.data && e.data.namespace === "dotli:protocol" && e.data.method === "resolveDotName") {
      window.parent.postMessage({
        namespace: "dotli:protocol",
        kind: "response",
        id: e.data.id,
        ok: true,
        result: null,
      }, "*");
    }
  });
`;

const successfulResolveResponse = (cid: string): string => `
  ${READY}
  window.addEventListener("message", function(e) {
    if (e.data && e.data.namespace === "dotli:protocol" && e.data.method === "resolveDotName") {
      window.parent.postMessage({
        namespace: "dotli:protocol",
        kind: "response",
        id: e.data.id,
        ok: true,
        result: ${JSON.stringify(cid)},
      }, "*");
    }
  });
`;

/** Rescale any setTimeout call whose delay matches `fromMs` down to `toMs`. */
async function shrinkTimeout(
  page: Page,
  fromMs: number,
  toMs: number,
): Promise<void> {
  await page.addInitScript(
    ([from, to]) => {
      const orig = window.setTimeout.bind(window);
      window.setTimeout = ((
        handler: TimerHandler,
        ms?: number,
        ...rest: unknown[]
      ) =>
        orig(
          handler,
          ms === from ? to : ms,
          ...rest,
        )) as typeof window.setTimeout;
    },
    [fromMs, toMs],
  );
}

test("As a user using smoldot directly, when the light client panics mid-resolution, I see the appropriate error and can switch backend", async ({
  page,
}) => {
  // Given
  await setBackend(page, "smoldot-direct");
  await mockProtocolIframe(page, fatalOnResolve("smoldot panic"));

  // When
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });

  // Then
  await expect(page.locator(".error-page-title")).toHaveText(
    "Domain can't be reached",
    { timeout: 10_000 },
  );
  await expect(page.locator(".error-page-detail")).toHaveText(
    HOST_ERRORS.FATAL_PANIC,
  );
  await expect(page.locator("#error-retry-btn")).toContainText(
    RETRY_LABEL_FROM_SMOLDOT,
  );
});

test("As a user using smoldot in shared worker, when the light client panics mid-resolution, I see the appropriate error and can switch backend", async ({
  page,
}) => {
  // Given
  await setBackend(page, "smoldot-shared-worker");
  await mockProtocolIframe(page, fatalOnResolve("smoldot panic"));

  // When
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });

  // Then
  await expect(page.locator(".error-page-title")).toHaveText(
    "Domain can't be reached",
    { timeout: 10_000 },
  );
  await expect(page.locator(".error-page-detail")).toHaveText(
    HOST_ERRORS.FATAL_PANIC,
  );
  await expect(page.locator("#error-retry-btn")).toContainText(
    RETRY_LABEL_FROM_SMOLDOT,
  );
});

test("As a user using smoldot in shared worker, when the browser can't create a worker, I see the appropriate error and can switch backend", async ({
  page,
}) => {
  // Given
  await setBackend(page, "smoldot-shared-worker");
  await mockProtocolIframe(
    page,
    initFailed("SharedWorker is not available in this browser"),
  );

  // When
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });

  // Then
  await expect(page.locator(".error-page-title")).toHaveText(
    "Domain can't be reached",
    { timeout: 10_000 },
  );
  await expect(page.locator(".error-page-detail")).toHaveText(
    HOST_ERRORS.SW_FAILED_TO_START,
  );
  await expect(page.locator("#error-retry-btn")).toContainText(
    RETRY_LABEL_FROM_SMOLDOT,
  );
});

test("As a user using smoldot in shared worker, when the worker dies silently, I see the appropriate error and can switch backend", async ({
  page,
}) => {
  // Given
  await setBackend(page, "smoldot-shared-worker");
  await mockProtocolIframe(
    page,
    initFailed("SharedWorker did not signal ready within timeout"),
  );

  // When
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });

  // Then
  await expect(page.locator(".error-page-title")).toHaveText(
    "Domain can't be reached",
    { timeout: 10_000 },
  );
  await expect(page.locator(".error-page-detail")).toHaveText(
    HOST_ERRORS.SW_TIMED_OUT,
  );
  await expect(page.locator("#error-retry-btn")).toContainText(
    RETRY_LABEL_FROM_SMOLDOT,
  );
});

test("As a user using smoldot directly, when loading is slow (>10s) I see a one-click gateway escape, and if it times out (>45s) I see the appropriate error and can switch backend", async ({
  page,
}) => {
  // Given
  await setBackend(page, "smoldot-direct");
  await shrinkTimeout(page, 10_000, 500);
  await mockProtocolIframe(
    page,
    errorResolveResponse(
      "Sync to Asset Hub Paseo timed out after 45s — unable to reach peers",
      1_500,
    ),
  );

  // When
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });

  // Then
  await expect(page.locator(".loading-gateway-btn")).toContainText(
    "Use Trusted Provider",
    { timeout: 5_000 },
  );
  await expect(page.locator(".error-page-title")).toHaveText(
    "Domain can't be reached",
    { timeout: 10_000 },
  );
  await expect(page.locator(".error-page-detail")).toHaveText(
    HOST_ERRORS.AH_SYNC_TIMEOUT,
  );
  await expect(page.locator("#error-retry-btn")).toContainText(
    RETRY_LABEL_FROM_SMOLDOT,
  );
});

test("As a user using smoldot in shared worker, when loading is slow (>10s) I see a one-click gateway escape, and if it times out (>45s) I see the appropriate error and can switch backend", async ({
  page,
}) => {
  // Given
  await setBackend(page, "smoldot-shared-worker");
  await shrinkTimeout(page, 10_000, 500);
  await mockProtocolIframe(
    page,
    errorResolveResponse(
      "Sync to Asset Hub Paseo timed out after 45s — unable to reach peers",
      1_500,
    ),
  );

  // When
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });

  // Then
  await expect(page.locator(".loading-gateway-btn")).toContainText(
    "Use Trusted Provider",
    { timeout: 5_000 },
  );
  await expect(page.locator(".error-page-title")).toHaveText(
    "Domain can't be reached",
    { timeout: 10_000 },
  );
  await expect(page.locator(".error-page-detail")).toHaveText(
    HOST_ERRORS.AH_SYNC_TIMEOUT,
  );
  await expect(page.locator("#error-retry-btn")).toContainText(
    RETRY_LABEL_FROM_SMOLDOT,
  );
});

test("As a user using smoldot directly, when I click the gateway escape, the backend flips to rpc-gateway and the page reloads", async ({
  page,
}) => {
  // Given
  await setBackend(page, "smoldot-direct");
  await shrinkTimeout(page, 10_000, 500);
  await mockProtocolIframe(
    page,
    errorResolveResponse("never resolves in test window", 30_000),
  );

  // When
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });
  const gatewayBtn = page.locator(".loading-gateway-btn");
  await expect(gatewayBtn).toContainText("Use Trusted Provider", {
    timeout: 5_000,
  });
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    gatewayBtn.click(),
  ]);

  // Then
  const backend = await page.evaluate(() =>
    localStorage.getItem("dotli:chain-backend"),
  );
  expect(backend).toBe("rpc-gateway");
});

test("As a user, when the app chunks fail to load mid-session, I see the appropriate error with a reload button", async ({
  page,
}) => {
  // Given
  await setBackend(page, "smoldot-direct");
  await page.route("**/assets/resolve-*.js", (route) => route.abort());

  // When
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });

  // Then
  await expect(page.locator(".error-page-title")).toHaveText(
    "Domain can't be reached",
    { timeout: 10_000 },
  );
  await expect(page.locator(".error-page-detail")).toHaveText(
    HOST_ERRORS.MODULE_FETCH_FAILED,
  );
  await expect(page.locator("#error-retry-btn")).toContainText("Reload");
});

test("As a user using smoldot directly, when smoldot rejects the chain spec, I see the appropriate error and can switch backend", async ({
  page,
}) => {
  // Given
  await setBackend(page, "smoldot-direct");
  await mockProtocolIframe(
    page,
    initFailed("Chain spec rejected: invalid checkpoint"),
  );

  // When
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });

  // Then
  await expect(page.locator(".error-page-title")).toHaveText(
    "Domain can't be reached",
    { timeout: 10_000 },
  );
  await expect(page.locator(".error-page-detail")).toHaveText(
    HOST_ERRORS.CHAIN_SPEC_REJECTED,
  );
  await expect(page.locator("#error-retry-btn")).toContainText(
    RETRY_LABEL_FROM_SMOLDOT,
  );
});

test("As a user using smoldot in shared worker, when smoldot rejects the chain spec, I see the appropriate error and can switch backend", async ({
  page,
}) => {
  // Given
  await setBackend(page, "smoldot-shared-worker");
  await mockProtocolIframe(
    page,
    initFailed("Chain spec rejected: invalid checkpoint"),
  );

  // When
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });

  // Then
  await expect(page.locator(".error-page-title")).toHaveText(
    "Domain can't be reached",
    { timeout: 10_000 },
  );
  await expect(page.locator(".error-page-detail")).toHaveText(
    HOST_ERRORS.CHAIN_SPEC_REJECTED,
  );
  await expect(page.locator("#error-retry-btn")).toContainText(
    RETRY_LABEL_FROM_SMOLDOT,
  );
});

test("As a user, when I visit a domain that has no content set, I see the appropriate message with the domain label", async ({
  page,
}) => {
  // Given
  await setBackend(page, "smoldot-direct");
  await mockProtocolIframe(page, nullResolveResponse);

  // When
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });

  // Then
  await expect(page.locator(".error-page-title")).toHaveText(
    "This app can't be reached",
    { timeout: 10_000 },
  );
  await expect(page.locator(".error-page-domain")).toHaveText(`${DOMAIN}.dot`);
  await expect(page.locator(".error-page-detail")).toContainText(
    "Check if there is a typo",
  );
  await expect(page.locator("#error-retry-btn")).toHaveCount(0);
});

test("As a user, when the domain's contenthash is unsupported or malformed, I see the appropriate error with no retry button", async ({
  page,
}) => {
  // Given
  await setBackend(page, "smoldot-direct");
  await mockProtocolIframe(
    page,
    errorResolveResponse("Failed to decode contenthash for example: bad codec"),
  );

  // When
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });

  // Then
  await expect(page.locator(".error-page-title")).toHaveText(
    "Domain can't be reached",
    { timeout: 10_000 },
  );
  await expect(page.locator(".error-page-detail")).toHaveText(
    HOST_ERRORS.CONTENTHASH_UNSUPPORTED,
  );
  await expect(page.locator("#error-retry-btn")).toHaveCount(0);
});

test("As a user, after a resolution failure, clicking retry switches backend and the app loads successfully", async ({
  page,
}) => {
  // Given
  await setBackend(page, "smoldot-direct");
  await mockProtocolIframe(page, fatalOnResolve("smoldot panic"));
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".error-page-title")).toHaveText(
    "Domain can't be reached",
    { timeout: 10_000 },
  );
  const backendBefore = await page.evaluate(() =>
    localStorage.getItem("dotli:chain-backend"),
  );
  expect(backendBefore).toBe("smoldot-direct");

  // When
  await page.locator("#error-retry-btn").click();
  await page.waitForLoadState("domcontentloaded");

  // Then
  const backendAfter = await page.evaluate(() =>
    localStorage.getItem("dotli:chain-backend"),
  );
  expect(backendAfter).toBe("rpc-gateway");
});

for (const [label, backend] of [
  ["per-product smoldot", "smoldot-direct"],
  ["shared smoldot", "smoldot-shared-worker"],
] as const) {
  test(`As a user using ${label}, the host must only spawn one instance of the light client`, async ({
    page,
  }) => {
    // Given
    await setBackend(page, backend);
    await mockProtocolIframe(
      page,
      successfulResolveResponse(
        "bafyfakebafyfakebafyfakebafyfakebafyfakebafyfa",
      ),
    );
    const workerUrls: string[] = [];
    page.on("worker", (worker) => {
      workerUrls.push(worker.url());
    });

    // When
    await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });
    await findAppFrame(page, 10_000);

    // Then
    const hostShellOrigin = `http://${DOMAIN}.localhost:${PORT}`;
    const hostShellSmoldotWorkers = workerUrls.filter(
      (url) =>
        url.startsWith(hostShellOrigin) && url.includes("smoldot_worker"),
    );
    expect(
      hostShellSmoldotWorkers,
      `host shell must not spawn a smoldot worker. apps/protocol owns smoldot. Found at host-shell origin:\n${hostShellSmoldotWorkers.join("\n")}`,
    ).toEqual([]);
  });
}
