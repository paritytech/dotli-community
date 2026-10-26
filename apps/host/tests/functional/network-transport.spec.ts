// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The gauge is read off the preview server's Sentry tunnel, not by route interception, which cannot see a
// SharedWorker's requests.

import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { DOMAIN, PORT, TIMEOUT_MS } from '../env.js';
import { findAppFrame } from '../product-frame.js';
import { seedBackend, seedSettings } from './fixtures/settings.js';
import { productPage, rawBlock } from './helpers/blocks.js';
import { fakeProtocol } from './helpers/fake-protocol.js';
import { resetSharedMode } from './helpers/shared-mode-reset.js';

const HOST_URL = `http://${DOMAIN}.localhost:${PORT}/`;
const HOST_SHELL_ORIGIN = `http://${DOMAIN}.localhost:${PORT}`;

// 127.0.0.1, as in `resetSharedMode`, because Node on the CI runner does not resolve `*.localhost`.
const METRICS_URL = `http://127.0.0.1:${PORT}/__dotli-metrics`;

// Past the end of the run, so each context emits only its startup point and the total counts contexts.
const HEARTBEAT_MS = 3_600_000;

type GaugePoint = {
  name: string;
  value: number;
  mode: string;
};

async function readGauge(request: APIRequestContext): Promise<GaugePoint[]> {
  const res = await request.get(METRICS_URL);
  if (!res.ok()) {
    throw new Error(`preview-server returned HTTP ${String(res.status())}`);
  }
  const points = (await res.json()) as GaugePoint[];
  return points.filter(p => p.name === 'dotli.smoldot.active');
}

/** Sentry sends a report up to one flush interval (5 s) after it is taken. */
const SENTRY_FLUSH_HOLD_MS = 6_000;

const total = (points: readonly GaugePoint[]): number => points.reduce((sum, p) => sum + p.value, 0);

/** Waits for the expected count, then holds for one Sentry flush. */
async function settledGauge(request: APIRequestContext, page: Page, expected: number): Promise<GaugePoint[]> {
  await expect
    .poll(async () => total(await readGauge(request)), {
      message: 'too few gauge points reached the Sentry tunnel. Build with npm run build:test',
      timeout: TIMEOUT_MS,
      intervals: [1_000],
    })
    .toBeGreaterThanOrEqual(expected);
  // Proves a negative: no further report is on its way, and nothing marks that, so the wait is one Sentry flush.
  await page.waitForTimeout(SENTRY_FLUSH_HOLD_MS);
  return readGauge(request);
}

for (const [label, backend, expected] of [
  ['per-product smoldot', 'smoldot-direct', 2],
  ['shared smoldot', 'smoldot-shared-worker', 1],
] as const) {
  test(`As a user using ${label}, two open tabs open ${String(expected)} active light client(s)`, async ({
    context,
    request,
  }) => {
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

    const points = await settledGauge(request, tabA, expected);

    // Then
    const count = total(points);
    expect(count, `expected ${String(expected)} light client(s) in ${backend}, saw ${String(count)}`).toBe(expected);

    // A run that silently fell back to another backend could still report the right number.
    const modes = [...new Set(points.map(p => p.mode))];
    expect(modes).toEqual([backend === 'smoldot-shared-worker' ? 'shared-worker' : 'direct']);
  });
}

// The protocol origin serves the same filename, so only the origin separates the legitimate fetch.
const LIGHT_CLIENT_WASM = /truapi_provider_bg.*\.wasm$/;

test('As a dotli visitor, the host shell must not download the light client wasm it never runs', async ({ page }) => {
  // Given: the product served offline from one block
  const block = await rawBlock(productPage('wasm'));
  await seedBackend(page, 'smoldot-direct');
  await fakeProtocol(page, { resolve: { kind: 'cid', cid: block.cid }, blocks: { [block.cid]: block.hex } });
  const hostShellWasm: string[] = [];
  page.context().on('request', request => {
    const url = request.url();
    if (url.startsWith(HOST_SHELL_ORIGIN) && LIGHT_CLIENT_WASM.test(url)) {
      hostShellWasm.push(url);
    }
  });

  // When: the host connects the product, so a fetch it starts after that goes unseen
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-product-frame]')).toHaveAttribute('data-product-frame', 'connected', {
    timeout: TIMEOUT_MS,
  });

  // Then
  expect(
    hostShellWasm,
    `the host shell fetched the light client wasm it never instantiates:\n${hostShellWasm.join('\n')}`,
  ).toEqual([]);
});
