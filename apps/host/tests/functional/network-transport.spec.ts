// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How many light clients two open tabs actually run.
 *
 * `packages/resolver/src/provider.ts` holds the client as a module singleton,
 * so a JS context has exactly 0 or 1. What varies is how many contexts exist:
 * `smoldot-direct` gives each tab its own protocol iframe, while
 * `smoldot-shared-worker` puts one SharedWorker behind every tab. The
 * `smoldot.active` gauge is only meaningful if it tells those two apart, and
 * nothing below the browser can prove that it does.
 *
 * The gauge is read off the preview server rather than through Playwright.
 * Sentry is configured with `tunnel: "/t"`, so envelopes are same-origin POSTs
 * the server can collect. Route interception would not work: it covers pages
 * and frames, and a SharedWorker's requests are neither, which would blind the
 * test to the exact case it exists to check.
 *
 * Limits. Only the startup emission is exercised, because the heartbeat
 * interval is set past the end of the run. The recurring tick is covered by
 * `packages/resolver/tests/provider-heartbeat.test.ts`. Two tabs, not N: the
 * distinction is one-versus-per-tab, and two separates them.
 *
 * Env overrides: DOMAIN, PORT, TIMEOUT_MS.
 */

import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { DOMAIN, PORT, TIMEOUT_MS } from "../env";
import { findAppFrame } from "../product-frame";
import { seedSettings, type Backend } from "./fixtures/settings";
import { resetSharedMode } from "./helpers/shared-mode-reset";

// The gauge compiles to a no-op unless the bundle was built with metrics on, so
// without the flag every assertion below would read zero and fail for a reason
// that has nothing to do with light clients. The Functional job sets it on both
// the build and the run; a local build that skips it skips this file too.
test.skip(
  process.env.VITE_METRICS !== "true",
  "needs a VITE_METRICS=true build",
);

const HOST_URL = `http://${DOMAIN}.localhost:${PORT}/`;

// Same `127.0.0.1` reasoning as `resetSharedMode`: Chromium resolves
// `*.localhost`, Node's resolver on the CI runner does not, and these endpoints
// gate on path rather than hostname.
const METRICS_URL = `http://127.0.0.1:${PORT}/__dotli-metrics`;

// Past the end of the run, so the only points collected are the one each
// context emits at startup and the total is a count of contexts. This fixes
// what is emitted, not when it arrives: Sentry's flush schedule is what
// `settledGauge` below has to wait out.
const HEARTBEAT_MS = 3_600_000;

interface GaugePoint {
  name: string;
  value: number;
  mode: string;
}

async function readGauge(
  request: APIRequestContext,
  mode: string,
): Promise<GaugePoint[]> {
  const res = await request.get(METRICS_URL);
  if (!res.ok()) {
    throw new Error(`preview-server returned HTTP ${String(res.status())}`);
  }
  const points = (await res.json()) as GaugePoint[];
  return points.filter(
    (p) => p.name === "dotli.smoldot.active" && p.mode === mode,
  );
}

// Long enough for a flush that lands after the last context reports, so an
// extra light client shows up rather than being read as the expected count.
const SETTLE_MS = 5_000;

/**
 * Wait for every context's point to arrive, then hold to see if more follow.
 *
 * Sentry buffers metrics and flushes on its own schedule, so one tab's point
 * can land seconds after another's. Waiting for the count to merely stop
 * changing reads the gap between two flushes as "settled", which undercounts:
 * CI saw 1 in `smoldot-direct` that way while the second tab was still in the
 * buffer. Wait for the expected count instead, then keep waiting.
 *
 * Not self-fulfilling. A count that never reaches `expected` still returns
 * whatever did arrive, and the caller's assertion fails with the real number.
 */
async function settledGauge(
  request: APIRequestContext,
  page: Page,
  expected: number,
  mode: string,
): Promise<GaugePoint[]> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const points = await readGauge(request, mode);
    if (points.reduce((sum, p) => sum + p.value, 0) >= expected) {
      break;
    }
    await page.waitForTimeout(1_000);
  }
  await page.waitForTimeout(SETTLE_MS);
  return readGauge(request, mode);
}

for (const [label, backend, expected] of [
  ["per-product smoldot", "smoldot-direct", 2],
  ["shared smoldot", "smoldot-shared-worker", 1],
] as const) {
  test(`As a user using ${label}, two open tabs open ${String(expected)} active light client(s)`, async ({
    context,
    request,
  }) => {
    test.setTimeout(TIMEOUT_MS * 4);

    // Given
    await resetSharedMode(request);
    await request.delete(METRICS_URL);
    await seedSettings(context, { backend: backend as Backend });
    await context.addInitScript((ms: number) => {
      try {
        sessionStorage.setItem("dotli:truapi-debug", "0");
        sessionStorage.setItem("dotli:smoldot-heartbeat-ms", String(ms));
        // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in exotic init contexts; the seed is best-effort.
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_MS);

    // When
    // Both tabs in the SAME context. A second context is a second SharedWorker,
    // and the shared case would read 2 exactly like the direct one.
    const tabA = await context.newPage();
    await tabA.goto(HOST_URL, { waitUntil: "domcontentloaded" });
    expect(await findAppFrame(tabA, TIMEOUT_MS)).not.toBeNull();

    const tabB = await context.newPage();
    await tabB.goto(HOST_URL, { waitUntil: "domcontentloaded" });
    expect(await findAppFrame(tabB, TIMEOUT_MS)).not.toBeNull();

    // The collector is process-wide. A prior test context can finish flushing
    // after DELETE, so isolate this assertion by the mode emitted with each
    // point. A backend fallback still fails: the requested mode contributes 0.
    const expectedMode =
      backend === "smoldot-shared-worker" ? "shared-worker" : "direct";
    const points = await settledGauge(request, tabA, expected, expectedMode);

    // Then
    const total = points.reduce((sum, p) => sum + p.value, 0);
    expect(
      total,
      `expected ${String(expected)} light client(s) in ${backend}, saw ${String(total)}`,
    ).toBe(expected);
  });
}
