// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The gauge is read off the preview server's Sentry tunnel, not by route interception, which cannot see a
// SharedWorker's requests.

import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { DOMAIN, PORT, TIMEOUT_MS } from '../env.js';
import { findAppFrame } from '../product-frame.js';
import { seedBackend, seedSettings } from './fixtures/settings.js';
import { resetSharedMode } from './helpers/shared-mode-reset.js';

const HOST_URL = `http://${DOMAIN}.localhost:${PORT}/`;
const HOST_SHELL_ORIGIN = `http://${DOMAIN}.localhost:${PORT}`;

// 127.0.0.1, as in `resetSharedMode`, because Node on the CI runner does not resolve `*.localhost`.
const METRICS_URL = `http://127.0.0.1:${PORT}/__dotli-metrics`;

// Past the end of the run, so each context emits only its startup point and the total counts contexts.
const HEARTBEAT_MS = 3_600_000;

interface GaugePoint {
  name: string;
  value: number;
  mode: string;
}

async function readGauge(request: APIRequestContext, mode: string): Promise<GaugePoint[]> {
  const res = await request.get(METRICS_URL);
  if (!res.ok()) {
    throw new Error(`preview-server returned HTTP ${String(res.status())}`);
  }
  const points = (await res.json()) as GaugePoint[];
  return points.filter(p => p.name === 'dotli.smoldot.active' && p.mode === mode);
}

// Long enough for a late flush to reveal an extra light client.
const SETTLE_MS = 5_000;

/**
 * Waits for the expected count, then holds for more. Waiting for the count to stop changing would read the gap
 * between two Sentry flushes as settled and undercount.
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
  ['per-product smoldot', 'smoldot-direct', 2],
  ['shared smoldot', 'smoldot-shared-worker', 1],
] as const) {
  test(`As a user using ${label}, two open tabs open ${String(expected)} active light client(s)`, async ({
    context,
    request,
  }) => {
    // Without a metrics build the gauge is a no-op and reads zero.
    test.skip(process.env['VITE_METRICS'] !== 'true', 'needs a VITE_METRICS=true build');
    test.setTimeout(TIMEOUT_MS * 4);

    // Given
    await resetSharedMode(request);
    await request.delete(METRICS_URL);
    await seedSettings(context, { backend: backend });
    await context.addInitScript((ms: number) => {
      try {
        sessionStorage.setItem('dotli:truapi-debug', '0');
        sessionStorage.setItem('dotli:smoldot-heartbeat-ms', String(ms));
        // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in exotic init contexts; the seed is best-effort.
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_MS);

    // When
    // Both tabs in the SAME context. A second context is a second SharedWorker,
    // and the shared case would read 2 exactly like the direct one.
    const tabA = await context.newPage();
    await tabA.goto(HOST_URL, { waitUntil: 'domcontentloaded' });
    expect(await findAppFrame(tabA, TIMEOUT_MS)).not.toBeNull();

    const tabB = await context.newPage();
    await tabB.goto(HOST_URL, { waitUntil: 'domcontentloaded' });
    expect(await findAppFrame(tabB, TIMEOUT_MS)).not.toBeNull();

    // The collector is process-wide. A prior test context can finish flushing
    // after DELETE, so isolate this assertion by the mode emitted with each
    // point. A backend fallback still fails: the requested mode contributes 0.
    const expectedMode = backend === 'smoldot-shared-worker' ? 'shared-worker' : 'direct';
    const points = await settledGauge(request, tabA, expected, expectedMode);

    // Then
    const total = points.reduce((sum, p) => sum + p.value, 0);
    expect(total, `expected ${String(expected)} light client(s) in ${backend}, saw ${String(total)}`).toBe(expected);

    // A run that silently fell back to another backend could still report the right number.
    const modes = [...new Set(points.map(p => p.mode))];
    expect(modes).toEqual([backend === 'smoldot-shared-worker' ? 'shared-worker' : 'direct']);
  });
}

// The protocol origin serves the same filename, so only the origin separates the legitimate fetch.
const LIGHT_CLIENT_WASM = /truapi_provider_bg.*\.wasm$/;

// Not derived from TIMEOUT_MS, which a fail-fast run sets low enough to expire inside this wait.
const WASM_SETTLE_MS = 20_000;

test('As a dotli visitor, the host shell must not download the light client wasm it never runs', async ({ page }) => {
  // Given
  // Default transport, which is what a first visit gets (`defaultBackend()` in
  // packages/config/src/mode.ts returns "smoldot-direct").
  await seedBackend(page, 'smoldot-direct', { onlyIfUnset: true });
  const hostShellWasm: string[] = [];
  page.context().on('request', request => {
    const url = request.url();
    if (url.startsWith(HOST_SHELL_ORIGIN) && LIGHT_CLIENT_WASM.test(url)) {
      hostShellWasm.push(url);
    }
  });

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });
  expect(await findAppFrame(page, TIMEOUT_MS)).not.toBeNull();
  // Gives a slow boot room to make the eager download before concluding it never happens.
  await page.waitForTimeout(WASM_SETTLE_MS);

  // Then
  expect(
    hostShellWasm,
    `the host shell fetched the light client wasm it never instantiates:\n${hostShellWasm.join('\n')}`,
  ).toEqual([]);
});
