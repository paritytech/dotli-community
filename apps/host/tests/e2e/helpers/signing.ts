// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, type Page, type Frame, type Locator } from "@playwright/test";

type PageLike = Page | Frame;

/**
 * Click run-<testId>, handle non-permission host dialogs, and wait for the log
 * entry to resolve. The worker fixture owns every "Allow" click; keeping one
 * permission driver avoids concurrent clicks when host dialogs overlap. The
 * bot signs automatically once the SignRequest hits the Statement Store.
 */
export async function runWebSignedTest(
  hostPage: Page,
  productFrame: PageLike,
  testId: string,
  manualDialogButtons: readonly string[],
  opts: { timeoutMs?: number; preClickDelayMs?: number } = {},
): Promise<"success" | "error"> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const preClickDelayMs = opts.preClickDelayMs ?? 0;
  const entries = productFrame.locator('[data-testid="log-entry"]');
  const initialCount = await entries.count();

  const btn = productFrame.locator(`[data-testid="run-${testId}"]`);
  await expect(btn).toBeVisible({ timeout: 10_000 });
  try {
    await expect(btn).toBeEnabled({ timeout: 15_000 });
  } catch {
    console.log(`[signed] ${testId}: DISABLED`);
    return "error";
  }
  console.log(`[signed] ${testId}: clicking run`);
  await btn.click();

  const dialogController = new AbortController();
  const dialogTask =
    manualDialogButtons.length > 0
      ? clickHostDialogs(
          hostPage,
          manualDialogButtons,
          60_000,
          preClickDelayMs,
          dialogController.signal,
        ).catch(() => {})
      : Promise.resolve();

  const result = await waitForLogResult(
    entries,
    initialCount,
    testId,
    timeoutMs,
  );
  dialogController.abort();
  await dialogTask;
  if (result === "error") {
    // On failure, dump the visible buttons on the host page. Invaluable for
    // diagnosing modal selector mismatches when the bot signs but Playwright
    // can't find the Allow/Sign button to click.
    const visibleButtons = await hostPage
      .locator("button:visible")
      .evaluateAll((els) =>
        els
          .map((e) => (e.textContent ?? "").trim().slice(0, 60))
          .filter(Boolean),
      )
      .catch(() => []);
    console.log(
      `[signed] ${testId}: visible buttons on host: ${JSON.stringify(visibleButtons)}`,
    );
  }
  return result;
}

/**
 * Drive non-permission host dialogs through their lifecycle. Permission
 * "Allow" modals are handled exclusively by the worker fixture.
 *
 * Strategy: poll for any of `buttonNames` to be visible. When one is, click
 * it. Keep polling until either no expected button has appeared for
 * `idleStopMs` (the flow has settled) or `timeoutMs` runs out. This handles
 * variable orderings and multiple sequential dialogs without needing the
 * caller to know the exact sequence.
 */
async function clickHostDialogs(
  page: Page,
  buttonNames: readonly string[],
  timeoutMs: number,
  preClickDelayMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const idleStopMs = 5_000; // declare done if no button appears for this long
  let lastSeenAt = Date.now();
  const seen = new Set<string>();

  while (!signal.aborted && Date.now() < deadline) {
    if (Date.now() - lastSeenAt > idleStopMs && seen.size > 0) {
      // We've handled at least one dialog and nothing new has shown for a
      // while, so assume the flow has moved past the modal phase.
      return;
    }

    let clickedThisPass = false;
    for (const name of buttonNames) {
      const btn = page.getByRole("button", { name, exact: true }).last();
      const visible = await btn.isVisible({ timeout: 250 }).catch(() => false);
      if (!visible) continue;

      if (preClickDelayMs > 0) {
        console.log(
          `[signed] dialog "${name}" visible — pausing ${preClickDelayMs}ms before click`,
        );
        await page.waitForTimeout(preClickDelayMs);
      }
      console.log(`[signed] dialog "${name}" — clicking`);
      await btn.click().catch((e: Error) => {
        console.log(`[signed] dialog "${name}" click failed: ${e.message}`);
      });
      seen.add(name);
      lastSeenAt = Date.now();
      clickedThisPass = true;
      // Brief pause to let the modal close before polling again, otherwise
      // we'd see the same button still visible on the next iteration.
      await page.waitForTimeout(500);
    }

    if (!clickedThisPass) {
      await page.waitForTimeout(500);
    }
  }

  if (signal.aborted) {
    return;
  }
  if (seen.size === 0) {
    console.log(
      `[signed] no host dialog appeared (looked for: ${buttonNames.join(", ")})`,
    );
  } else {
    console.log(
      `[signed] dialog budget exhausted after seeing: ${[...seen].join(", ")}`,
    );
  }
}

async function waitForLogResult(
  entries: Locator,
  initialCount: number,
  testId: string,
  timeoutMs: number,
): Promise<"success" | "error"> {
  try {
    await expect
      .poll(async () => entries.count(), { timeout: 10_000 })
      .toBeGreaterThan(initialCount);
  } catch {
    console.log(`[signed] ${testId}: no log entry within 10s`);
    return "error";
  }

  const newest = entries.first();
  try {
    await expect(newest).not.toHaveAttribute("data-status", "pending", {
      timeout: timeoutMs,
    });
  } catch {
    console.log(`[signed] ${testId}: stuck pending`);
    return "error";
  }

  const status = await newest.getAttribute("data-status");
  if (status !== "success") {
    const msg = await newest
      .locator("div.break-all")
      .textContent()
      .catch(() => "");
    console.log(`[signed] ${testId}: ${(msg ?? "").slice(0, 300)}`);
  }
  return status === "success" ? "success" : "error";
}
