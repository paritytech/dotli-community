// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The real protocol frame telling the host what its light client did, in both modes. Offline: the light client is
// stopped before it dials, or its sockets are refused, so nothing here waits on a chain.

import { expect } from '@playwright/test';
import { ERROR_TITLES, HOST_ERRORS } from '../../src/error-copy.js';
import { PORT } from '../env.js';
import { seedBackend, type Backend } from './fixtures/settings.js';
import { isProtocolFrameUrl } from './helpers/frames.js';
import { recordProtocolMessages, waitForProtocolMessage, type MessageMatch } from './helpers/wire-recorder.js';
import { test } from './helpers/shared-mode-reset.js';
import { BLOCK_PROVIDER_WASM, PROTOCOL_SHARED_WORKER, prependToWorker } from './helpers/worker-prelude.js';

const HOST_URL = `http://host-playground.localhost:${PORT}/`;

/** The telemetry event that tells how `chain` started from its stored database. */
const smoldotDb = (chain: string): MessageMatch => ({
  section: 'frame',
  method: 'telemetry',
  tag: 'receive',
  body: { tag: 'smoldotDb', value: { chain } },
});

/** The frame status ending, as the frame's typed failure. */
const frameStatusEnd: MessageMatch = { section: 'frame', method: 'status', tag: 'interrupt' };

const isProviderWasm = (url: URL): boolean =>
  isProtocolFrameUrl(url.href) && url.pathname.includes('truapi_provider_bg');

test('As a user on a per-tab light client that cannot start, I see the crash the protocol frame reports', async ({
  page,
}) => {
  // Given
  await seedBackend(page, 'smoldot-direct');
  await recordProtocolMessages(page);
  await page.route(isProviderWasm, route => route.abort());

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

  // Then
  const status = await waitForProtocolMessage(page, frameStatusEnd, 15_000);
  expect(status.body).toMatchObject({
    success: false,
    value: { tag: 'Domain', value: { tag: 'fatal', value: expect.stringContaining('connection failed') } },
  });
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE);
  await expect(page.getByTestId('error-page-detail')).toHaveText(HOST_ERRORS.FATAL_PANIC);
});

test('As a user on a shared light client that cannot start, I see the crash the worker reports through the protocol frame', async ({
  page,
}) => {
  // Given
  await seedBackend(page, 'smoldot-shared-worker');
  await recordProtocolMessages(page);
  await prependToWorker(page.context(), PROTOCOL_SHARED_WORKER, BLOCK_PROVIDER_WASM);

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

  // Then
  const status = await waitForProtocolMessage(page, frameStatusEnd, 15_000);
  expect(status.body).toMatchObject({
    success: false,
    value: { tag: 'Domain', value: { tag: 'fatal', value: expect.stringContaining('connection failed') } },
  });
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE);
  await expect(page.getByTestId('error-page-detail')).toHaveText(HOST_ERRORS.FATAL_PANIC);
});

for (const [label, backend] of [
  ['a per-tab', 'smoldot-direct'],
  ['a shared', 'smoldot-shared-worker'],
] as const satisfies readonly (readonly [string, Backend])[]) {
  test(`As a first-time user on ${label} light client, the host hears that no chain started from a stored database`, async ({
    page,
  }) => {
    // Given: a fresh profile, and no peer to reach
    await seedBackend(page, backend);
    await recordProtocolMessages(page);
    await page.context().routeWebSocket(/^wss?:\/\//, socket => socket.close());

    // When
    await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

    // Then
    const relay = await waitForProtocolMessage(page, smoldotDb('relay'), 15_000);
    const hub = await waitForProtocolMessage(page, smoldotDb('assethub'), 15_000);
    expect([relay.body, hub.body]).toEqual([
      { tag: 'smoldotDb', value: { chain: 'relay', outcome: 'miss' } },
      { tag: 'smoldotDb', value: { chain: 'assethub', outcome: 'miss' } },
    ]);
  });
}
