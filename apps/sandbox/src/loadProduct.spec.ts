// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';

import type { ArchiveFiles, FetchResult } from '@dotli/content';
import { recordLog } from '@dotli/shared/testing';

import { loadProduct, type LoadProductDeps, type SandboxParams } from './loadProduct.js';

type FetchArchive = LoadProductDeps['fetchArchive'];

type Harness = {
  deps: LoadProductDeps;
  /** What the load did, in order. */
  events: string[];
  /** The options each `fetchArchive` call got. */
  fetches: Parameters<FetchArchive>[1][];
  workers: { waitForFreshController: boolean }[];
  written: string[];
  stored: ArchiveFiles[];
  reports: Parameters<LoadProductDeps['report']>[0][];
};

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const BLOCK_SOURCE = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array());

function createParams(overrides: Partial<SandboxParams> = {}): SandboxParams {
  return {
    cid: CID,
    backend: 'rpc-gateway',
    network: 'paseo-next-v2',
    fullReset: false,
    resolutionId: 'flow-1',
    ...overrides,
  };
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A sandbox page whose network, worker and window are fakes. `fetched` is what the fetch gives back or throws. */
function createHarness(fetched: FetchResult | Error, overrides: Partial<LoadProductDeps> = {}): Harness {
  const events: string[] = [];
  const fetches: Parameters<FetchArchive>[1][] = [];
  const workers: { waitForFreshController: boolean }[] = [];
  const written: string[] = [];
  const stored: ArchiveFiles[] = [];
  const reports: Harness['reports'] = [];
  const deps: LoadProductDeps = {
    showStatus: message => {
      events.push(`status: ${message}`);
    },
    purge() {
      events.push('purge');
      return Promise.resolve();
    },
    registerWorker(options) {
      events.push('worker');
      workers.push(options);
      return Promise.resolve();
    },
    isControlled: () => true,
    fetchArchive(_cid, params) {
      const { onStatus: _onStatus, ...options } = params ?? {};
      fetches.push(options);
      return fetched instanceof Error ? Promise.reject(fetched) : Promise.resolve(fetched);
    },
    blockSource: null,
    decrypt: () => Promise.resolve(null),
    storeArchive(files) {
      events.push('store');
      stored.push(files);
      return Promise.resolve();
    },
    prepareHtml: html => Promise.resolve(html),
    report: report => {
      reports.push(report);
    },
    notifyLoaded: () => {
      events.push('loaded');
    },
    write(html) {
      events.push('write');
      written.push(html);
    },
    measureSinceStart: () => 42,
    ...overrides,
  };
  return { deps, events, fetches, workers, written, stored, reports };
}

describe('loadProduct', () => {
  it('As a visitor on the gateway backend, I get the product page fetched over the gateway and written into the window', async () => {
    // Given a gateway that serves a single page
    const page = createHarness({ type: 'single', content: encode('<h1>hi</h1>') });

    // When the first attempt loads it
    const outcome = await loadProduct({ params: createParams(), attempt: 1 }, page.deps);

    // Then the page is written after the host hears it loaded, and the write is reported
    expect(outcome).toEqual({ outcome: 'loaded' });
    expect(page.fetches).toEqual([{ useGateway: true }]);
    expect(page.written).toEqual(['<h1>hi</h1>']);
    expect(page.events.slice(-2)).toEqual(['loaded', 'write']);
    expect(page.reports).toEqual([
      { event: 'document_written', flowId: 'flow-1', payload: { cid: CID, totalMs: 42, bytes: 11, fileCount: 1 } },
    ]);
  });

  it("As a visitor on a light client backend, I open the product and its content is fetched through the host's block relay", async () => {
    // Given a light client backend whose block source is the relay
    const page = createHarness({ type: 'single', content: encode('<h1>hi</h1>') }, { blockSource: BLOCK_SOURCE });

    // When the first attempt loads it
    const outcome = await loadProduct({ params: createParams({ backend: 'smoldot-direct' }), attempt: 1 }, page.deps);

    // Then the fetch reads its blocks from the relay
    expect(outcome).toEqual({ outcome: 'loaded' });
    expect(page.fetches).toEqual([{ bitswapBlockSource: BLOCK_SOURCE }]);
  });

  it('As a visitor, I open an archive and it is handed to the service worker before its index is written', async () => {
    // Given an archive with an index and a script
    const files = { 'index.html': encode('<main>app</main>'), 'app.js': encode('run()') };
    const page = createHarness({ type: 'archive', files });

    // When the first attempt loads it
    const outcome = await loadProduct({ params: createParams(), attempt: 1 }, page.deps);

    // Then the worker holds the files before the index is written
    expect(outcome).toEqual({ outcome: 'loaded' });
    expect(page.stored).toEqual([files]);
    expect(page.written).toEqual(['<main>app</main>']);
    expect(page.events.indexOf('store')).toBeLessThan(page.events.indexOf('write'));
  });

  it('As a visitor, I open encrypted content and am served the files it decrypts to', async () => {
    // Given sealed content that decrypts to an archive
    const files = { 'index.html': encode('<p>secret</p>') };
    const page = createHarness(
      { type: 'single', content: encode('sealed') },
      { decrypt: () => Promise.resolve(files) },
    );

    // When the first attempt loads it
    const outcome = await loadProduct({ params: createParams(), attempt: 1 }, page.deps);

    // Then the decrypted archive is stored and its index written
    expect(outcome).toEqual({ outcome: 'loaded' });
    expect(page.stored).toEqual([files]);
    expect(page.written).toEqual(['<p>secret</p>']);
  });

  it('As an operator, I load an archive with no index.html and see it fail at the archive index step', async () => {
    // Given an archive without an index
    const page = createHarness({ type: 'archive', files: { 'app.js': encode('run()') } });

    // When the first attempt loads it
    const outcome = await loadProduct({ params: createParams(), attempt: 1 }, page.deps);

    // Then nothing is written
    expect(outcome).toMatchObject({ outcome: 'failed', step: 'archive_index' });
    expect(page.written).toEqual([]);
  });

  it('As an operator, I load content that does not match its CID and see it fail at the verify step', async () => {
    // Given a fetch that rejects the bytes it got
    const mismatch = Object.assign(new Error(`Content hash mismatch for ${CID}`), { name: 'ContentVerificationError' });
    const page = createHarness(mismatch);

    // When the first attempt loads it
    const outcome = await loadProduct({ params: createParams(), attempt: 1 }, page.deps);

    // Then the failure is the verification, not the fetch
    expect(outcome).toEqual({ outcome: 'failed', step: 'verify', error: mismatch });
  });

  it('As an operator, I load from an unreachable gateway and see it fail at the content fetch step', async () => {
    // Given a gateway the browser cannot reach
    const unreachable = new TypeError('Failed to fetch');
    const page = createHarness(unreachable);

    // When the first attempt loads it
    const outcome = await loadProduct({ params: createParams(), attempt: 1 }, page.deps);

    // Then the failure names the fetch
    expect(outcome).toEqual({ outcome: 'failed', step: 'content_fetch', error: unreachable });
  });

  it.each<[string, (broken: Error) => Partial<LoadProductDeps>, FetchResult]>([
    [
      'sw_register',
      broken => ({ registerWorker: () => Promise.reject(broken) }),
      { type: 'single', content: encode('') },
    ],
    ['decrypt', broken => ({ decrypt: () => Promise.reject(broken) }), { type: 'single', content: encode('sealed') }],
    [
      'sw_store',
      broken => ({ storeArchive: () => Promise.reject(broken) }),
      { type: 'archive', files: { 'index.html': encode('<main>app</main>') } },
    ],
    [
      'render',
      broken => ({ prepareHtml: () => Promise.reject(broken) }),
      { type: 'single', content: encode('<p>hi</p>') },
    ],
  ])(
    'As an operator on a light client backend, I break the %s step and see the failure reported at that step',
    async (step, breaks, fetched) => {
      // Given a light client load whose step throws
      const broken = new Error(`${step} broke`);
      const page = createHarness(fetched, { blockSource: BLOCK_SOURCE, ...breaks(broken) });

      // When the first attempt loads it
      const outcome = await loadProduct({ params: createParams({ backend: 'smoldot-direct' }), attempt: 1 }, page.deps);

      // Then the failure names that step, and nothing is written
      expect(outcome).toEqual({ outcome: 'failed', step, error: broken });
      expect(page.written).toEqual([]);
    },
  );

  it('As a visitor, I leave mid-load and the fetch the frame tore down ends the load quietly', async () => {
    // Given a relay fetch aborted by the frame's teardown
    const page = createHarness(new DOMException('The sandbox frame was torn down', 'AbortError'));

    // When the first attempt loads it
    const outcome = await loadProduct({ params: createParams({ backend: 'smoldot-direct' }), attempt: 1 }, page.deps);

    // Then the load ends as torn down, not failed
    expect(outcome).toEqual({ outcome: 'torn_down' });
  });

  it('As a visitor, I hit a plain error whose message reads like a teardown and it is still shown as a failure', async () => {
    // Given a fetch that failed with an ordinary error, not an abort
    const broken = new Error('bitswap-relay: aborted, the sandbox frame was torn down');
    const page = createHarness(broken);

    // When the first attempt loads it
    const outcome = await loadProduct({ params: createParams({ backend: 'smoldot-direct' }), attempt: 1 }, page.deps);

    // Then the load fails at the content fetch with that error
    expect(outcome).toEqual({ outcome: 'failed', step: 'content_fetch', error: broken });
  });

  it.each([true, false])(
    "As an operator, I read the service worker's ready line and see whether a worker controls the page (%s)",
    async controlled => {
      // Given a page whose control the worker reports
      const logs = recordLog({ onFinished: onTestFinished });
      const page = createHarness(
        { type: 'single', content: encode('<h1>hi</h1>') },
        { isControlled: () => controlled },
      );

      // When the first attempt loads it
      await loadProduct({ params: createParams(), attempt: 1 }, page.deps);

      // Then the ready line carries it
      expect(logs.find(line => line.message === 'Service worker ready')?.attrs).toMatchObject({ controlled });
    },
  );

  it('As a visitor asking for a full reset, I get the origin wiped and a fresh worker awaited on the first attempt only', async () => {
    // Given a full reset whose fetch fails
    const page = createHarness(new TypeError('Failed to fetch'));

    // When the first attempt fails and the visitor retries
    await loadProduct({ params: createParams({ fullReset: true }), attempt: 1 }, page.deps);
    await loadProduct({ params: createParams({ fullReset: true }), attempt: 2 }, page.deps);

    // Then only the first attempt purged, before its worker registered
    expect(page.events.filter(event => event === 'purge')).toHaveLength(1);
    expect(page.events.indexOf('purge')).toBeLessThan(page.events.indexOf('worker'));
    expect(page.workers).toEqual([{ waitForFreshController: true }, { waitForFreshController: false }]);
  });
});
