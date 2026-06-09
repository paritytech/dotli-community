// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browser-context scaffolding for specs that bridge iframe and worker
 * console output to the page.
 *
 * `setupContext` returns a fresh `BrowserContext` with OS-level
 * permission grants, document and worker route handlers that inject
 * the console-bridge forwarders, and a SharedWorker shim that pipes
 * worker logs back. It carries no test-specific seed. Callers layer
 * `seedSettings` (or any other init script) on top.
 */

import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Page,
} from "@playwright/test";
import {
  IFRAME_FORWARDER,
  SHARED_WORKER_FORWARDER,
  WORKER_FORWARDER,
} from "../../iframe-logs-forwarder";
import { BROWSER_PERMISSIONS, seedPermissions } from "../fixtures/permissions";
import { seedSettings, type SettingsSeed } from "../fixtures/settings";

export interface PageWithCapture {
  page: Page;
  consoleErrors: string[];
  consoleMessages: string[];
}

export interface TestSetup extends PageWithCapture {
  context: BrowserContext;
}

/**
 * One-call test bootstrap.
 *
 * Builds a fresh context with browser permissions, route handlers, and
 * the SharedWorker shim. Seeds dotli permissions and the requested
 * backend/cache settings into localStorage. Returns a page with
 * console capture attached. Cleanup is the caller's responsibility
 * via `context.close()`.
 */
export async function setupTest(
  browser: Browser,
  settings: SettingsSeed,
): Promise<TestSetup> {
  const context = await setupContext(browser);
  await seedPermissions(context);
  await seedSettings(context, settings);
  const captured = await newPageWithCapture(context);
  return { context, ...captured };
}

export async function setupContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    storageState: undefined,
    serviceWorkers: "allow",
    permissions: [...BROWSER_PERMISSIONS],
  });

  await context.route("**", async (route) => {
    const req = route.request();
    if (req.resourceType() !== "document") {
      await route.continue();
      return;
    }
    process.stdout.write(`[route:doc] ${req.url()}\n`);
    try {
      const response = await route.fetch();
      const ct = (response.headers()["content-type"] || "").toLowerCase();
      const body = await response.text();
      const injected = body.replace(
        /<head(\s[^>]*)?>/i,
        (m) => `${m}${IFRAME_FORWARDER}`,
      );
      const finalBody =
        body.length > 0 && injected !== body
          ? injected
          : IFRAME_FORWARDER + body;
      await route.fulfill({
        response,
        body: finalBody,
        headers: { ...response.headers(), "content-type": "text/html" },
      });
      process.stdout.write(
        `[route:doc:done] ${req.url()} ct=${ct || "(none)"} injected=${String(finalBody !== body)}\n`,
      );
    } catch (err) {
      process.stdout.write(
        `[route:doc:err] ${req.url()} ${err instanceof Error ? err.message : String(err)}\n`,
      );
      await route.continue();
    }
  });
  await context.route("**/*smoldot_worker*.js", async (route) => {
    try {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({
        response,
        body: WORKER_FORWARDER + body,
        headers: {
          ...response.headers(),
          "content-type": "application/javascript",
        },
      });
    } catch {
      await route.continue();
    }
  });

  await context.route("**/protocol-shared-worker-*.js", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({
      body: SHARED_WORKER_FORWARDER + body,
      contentType: "application/javascript",
    });
  });

  await context.addInitScript(() => {
    const OrigSW = window.SharedWorker;
    // @ts-expect-error: replacing global constructor
    window.SharedWorker = function (
      url: string,
      opts?: WorkerOptions | string,
    ) {
      const sw = new OrigSW(url, opts);
      sw.port.addEventListener(
        "message",
        (e: MessageEvent<{ __pw_sw_log__?: boolean; text?: string }>) => {
          if (e.data.__pw_sw_log__ === true) {
            console.warn(`[SW] ${e.data.text ?? ""}`);
          }
        },
      );
      return sw;
    };
  });

  return context;
}

export async function newPageWithCapture(
  context: BrowserContext,
): Promise<PageWithCapture> {
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const consoleMessages: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
    const text = msg.text();
    consoleMessages.push(text);
    if (text.startsWith("[FRAMELOG]")) {
      console.log(text);
    } else if (msg.type() === "error") {
      console.log(`[raw:error] ${text}`);
    }
  });
  return { page, consoleErrors, consoleMessages };
}

export function dumpConsoleErrors(label: string, errors: string[]): void {
  if (errors.length === 0) {
    return;
  }
  console.log(`\n--- console errors (${label}) ---`);
  for (const line of errors.slice(0, 20)) {
    console.log(`  ${line}`);
  }
}
