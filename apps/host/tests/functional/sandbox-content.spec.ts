// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product's content on its way from the protocol frame through the host's block relay to the sandbox. Offline: a
// fake protocol frame serves the blocks, so each test steers when a block arrives.

import { expect, type Frame } from '@playwright/test';
import { PORT } from '../env.js';
import { SKIP_ARCHIVE_ONLY, seedBackend, seedSettings } from './fixtures/settings.js';
import { productPage, rawBlock } from './helpers/blocks.js';
import { blockGets, fakeProtocol, releaseBlock, setBlockMode } from './helpers/fake-protocol.js';
import { isSandboxUrl, waitForAppEnd, waitForFrame, waitForRenderedSandbox } from './helpers/frames.js';
import { test } from './helpers/shared-mode-reset.js';

const HOST_URL = `http://host-playground.localhost:${PORT}/`;
const STUB_URL = `http://stub.app.localhost:${PORT}/e2e-stub`;

const MARKER_DB = 'e2e-marker';

function databaseNames(frame: Frame): Promise<string[]> {
  return frame.evaluate(async () => (await indexedDB.databases()).map(db => db.name ?? ''));
}

test('As a user who reset everything, my product loads on the retry, and only the first attempt wiped its origin', async ({
  page,
}) => {
  // Given: a reset is pending for the sandbox, and the first ask for the product's block is refused
  const block = await rawBlock(productPage('reset'));
  await seedBackend(page, 'smoldot-direct');
  await fakeProtocol(page, {
    resolve: { kind: 'cid', cid: block.cid },
    blocks: { [block.cid]: block.hex },
    modes: { [block.cid]: 'fail' },
  });
  await page.addInitScript(() => {
    if (window.top === window && location.hostname.endsWith('.localhost') && !location.hostname.includes('.app.')) {
      sessionStorage.setItem('dotli:pending-reset:sandbox', '1');
    }
  });
  const sandboxDocuments: string[] = [];
  page.on('request', request => {
    if (request.resourceType() === 'document' && isSandboxUrl(request.url())) {
      sandboxDocuments.push(request.url());
    }
  });
  await page.goto(HOST_URL);
  const sandbox = await waitForFrame(page, isSandboxUrl, 15_000);
  await expect(sandbox.getByTestId('error-page-title')).toHaveText('Failed to load content', { timeout: 15_000 });
  await sandbox.evaluate(
    name =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => {
          open.result.close();
          resolve();
        };
        open.onerror = () => {
          reject(open.error ?? new Error('the marker database did not open'));
        };
      }),
    MARKER_DB,
  );
  await setBlockMode(page, block.cid, 'serve');

  // When
  await sandbox.getByRole('button', { name: 'Retry' }).click();

  // Then
  await waitForAppEnd(sandbox, 15_000);
  await expect(sandbox.getByTestId('e2e-product')).toHaveText('reset');
  expect(sandboxDocuments).toHaveLength(1);
  expect(new URL(sandboxDocuments[0] ?? '').searchParams.get('fullReset')).toBe('1');
  expect(await databaseNames(sandbox)).toContain(MARKER_DB);
});

test('As a user whose page asks for the same block from two frames at once, the block is fetched once and both get it', async ({
  page,
}) => {
  // Given: the archive cache is off, so both asks go to the network in the order they arrive
  const product = await rawBlock(productPage('shared'));
  const sentinel = await rawBlock('sentinel');
  await seedSettings(page.context(), { backend: 'smoldot-direct', cacheSeed: SKIP_ARCHIVE_ONLY });
  await fakeProtocol(page, {
    resolve: { kind: 'cid', cid: product.cid },
    blocks: { [product.cid]: product.hex, [sentinel.cid]: sentinel.hex },
    modes: { [product.cid]: 'hold' },
  });
  await page.route(STUB_URL, route =>
    route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><html><body>stub</body></html>' }),
  );
  await page.goto(HOST_URL);
  await expect.poll(() => blockGets(page, product.cid)).toBe(1);

  // When: a second frame asks for the held block, then for one the fake answers at once
  await page.evaluate(url => {
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.dataset['testid'] = 'e2e-stub';
    document.body.appendChild(iframe);
  }, STUB_URL);
  const stub = await waitForFrame(page, url => url === STUB_URL, 10_000);
  await stub.evaluate(
    ([held, answered]) => {
      const results: Record<string, unknown> = {};
      Object.defineProperty(window, '__e2eResults', { value: results });
      window.addEventListener('message', (event: MessageEvent<{ type?: string; id?: string }>) => {
        if (event.data.type === 'dotli:bitswap-result' && event.data.id !== undefined) {
          results[event.data.id] = event.data;
        }
      });
      window.parent.postMessage({ type: 'dotli:bitswap-get', id: 'held', cid: held }, '*');
      window.parent.postMessage({ type: 'dotli:bitswap-get', id: 'answered', cid: answered }, '*');
    },
    [product.cid, sentinel.cid] as const,
  );
  // The host handles a frame's messages in order, so its ask for the held block is already waiting.
  await expect.poll(() => blockGets(page, sentinel.cid)).toBe(1);
  await releaseBlock(page, product.cid);

  // Then
  const sandbox = await waitForRenderedSandbox(page, 15_000);
  await expect(sandbox.getByTestId('e2e-product')).toHaveText('shared');
  const stubBytes = await stub.waitForFunction(() => {
    const result = (window as unknown as { __e2eResults: Record<string, { ok: boolean; bytes?: Uint8Array }> })
      .__e2eResults['held'];
    return result?.ok === true && result.bytes !== undefined ? new TextDecoder().decode(result.bytes) : undefined;
  });
  expect(await stubBytes.jsonValue()).toBe(productPage('shared'));
  expect(await blockGets(page, product.cid)).toBe(1);
});

test('As a user whose product frame reloads mid-download, the new frame gets its block without waiting out the old fetch', async ({
  page,
}) => {
  // Given: the first ask for the product's block never answers
  const block = await rawBlock(productPage('reloaded'));
  await seedBackend(page, 'smoldot-direct');
  await fakeProtocol(page, {
    resolve: { kind: 'cid', cid: block.cid },
    blocks: { [block.cid]: block.hex },
    modes: { [block.cid]: 'hold-first' },
  });
  await page.goto(HOST_URL);
  const sandbox = await waitForFrame(page, isSandboxUrl, 15_000);
  await expect.poll(() => blockGets(page, block.cid)).toBe(1);

  // When
  await sandbox.goto(sandbox.url());

  // Then: the old fetch was aborted, or the new ask would queue behind it for a minute
  await expect.poll(() => blockGets(page, block.cid), { timeout: 20_000 }).toBe(2);
  const rendered = await waitForRenderedSandbox(page, 20_000);
  await expect(rendered.getByTestId('e2e-product')).toHaveText('reloaded');
});
