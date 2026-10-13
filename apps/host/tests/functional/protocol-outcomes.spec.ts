// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The real protocol frame telling the host what its light client did, in both modes. Offline: the light client is
// stopped before it dials, or its sockets are refused, so nothing here waits on a chain.

import { expect } from '@playwright/test';
import { ERROR_TITLES, HOST_ERRORS } from '../../src/error-copy.js';
import { PORT } from '../env.js';
import { seedBackend, type Backend } from './fixtures/settings.js';
import { recordProtocolEnvelopes, waitForEnvelope } from './helpers/envelopes.js';
import { test } from './helpers/shared-mode-reset.js';
import { BLOCK_PROVIDER_WASM, PROTOCOL_SHARED_WORKER, prependToWorker } from './helpers/worker-prelude.js';

const HOST_URL = `http://host-playground.localhost:${PORT}/`;

const isProviderWasm = (url: URL): boolean =>
  url.hostname === 'host.localhost' && url.pathname.includes('truapi_provider_bg');

test('As a user on a per-tab light client that cannot start, I see the crash the protocol frame reports', async ({
  page,
}) => {
  // Given
  await seedBackend(page, 'smoldot-direct');
  await recordProtocolEnvelopes(page);
  await page.route(isProviderWasm, route => route.abort());

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

  // Then
  const fatal = await waitForEnvelope(page, 'fatal', 15_000);
  expect(fatal['message']).toEqual(expect.stringContaining('connection failed'));
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE);
  await expect(page.getByTestId('error-page-detail')).toHaveText(HOST_ERRORS.FATAL_PANIC);
});

test('As a user on a shared light client that cannot start, I see the crash the worker reports through the protocol frame', async ({
  page,
}) => {
  // Given
  await seedBackend(page, 'smoldot-shared-worker');
  await recordProtocolEnvelopes(page);
  await prependToWorker(page.context(), PROTOCOL_SHARED_WORKER, BLOCK_PROVIDER_WASM);

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

  // Then
  const fatal = await waitForEnvelope(page, 'fatal', 15_000);
  expect(fatal['message']).toEqual(expect.stringContaining('connection failed'));
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
    await recordProtocolEnvelopes(page);
    await page.context().routeWebSocket(/^wss?:\/\//, socket => socket.close());

    // When
    await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

    // Then
    const relay = await waitForEnvelope(page, 'smoldot-db', 15_000, { chain: 'relay' });
    const hub = await waitForEnvelope(page, 'smoldot-db', 15_000, { chain: 'hub' });
    expect([relay['outcome'], hub['outcome']]).toEqual(['miss', 'miss']);
  });
}
