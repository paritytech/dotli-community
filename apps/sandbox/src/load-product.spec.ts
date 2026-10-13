// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import type { ArchiveFiles, FetchResult } from '@dotli/content';

import { loadProduct, type LoadProductDeps, type SandboxParams } from './load-product.js';

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function params(overrides: Partial<SandboxParams> = {}): SandboxParams {
  return {
    cid: CID,
    chainBackend: 'rpc-gateway',
    network: 'paseo-next-v2',
    fullReset: false,
    resolutionId: 'flow-1',
    ...overrides,
  };
}

type FetchArchive = LoadProductDeps['fetchArchive'];

interface Harness {
  deps: LoadProductDeps;
  /** What the load did, in order. */
  events: string[];
  /** The options each `fetchArchive` call got. */
  fetches: Parameters<FetchArchive>[2][];
  workers: { waitForFreshController: boolean }[];
  written: string[];
  stored: ArchiveFiles[];
  reports: { event: string; flowId: string; payload: Record<string, unknown> }[];
}

const BLOCK_SOURCE = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array());

/** A sandbox page whose network, worker and window are fakes. `fetched` is what the fetch gives back or throws. */
function harness(fetched: FetchResult | Error, overrides: Partial<LoadProductDeps> = {}): Harness {
  const events: string[] = [];
  const fetches: Parameters<FetchArchive>[2][] = [];
  const workers: { waitForFreshController: boolean }[] = [];
  const written: string[] = [];
  const stored: ArchiveFiles[] = [];
  const reports: Harness['reports'] = [];
  const deps: LoadProductDeps = {
    showStatus: message => {
      events.push(`status: ${message}`);
    },
    purge: () => {
      events.push('purge');
      return Promise.resolve();
    },
    registerWorker: options => {
      events.push('worker');
      workers.push(options);
      return Promise.resolve();
    },
    fetchArchive: (_cid, _onStatus, options) => {
      fetches.push(options);
      return fetched instanceof Error ? Promise.reject(fetched) : Promise.resolve(fetched);
    },
    blockSource: null,
    decrypt: () => Promise.resolve(null),
    storeArchive: files => {
      events.push('store');
      stored.push(files);
      return Promise.resolve();
    },
    prepareHtml: html => Promise.resolve(html),
    report: (event, flowId, payload) => {
      reports.push({ event, flowId, payload });
    },
    loaded: () => {
      events.push('loaded');
    },
    write: html => {
      events.push('write');
      written.push(html);
    },
    sinceStart: () => 42,
    ...overrides,
  };
  return { deps, events, fetches, workers, written, stored, reports };
}

describe('loadProduct', () => {
  it('As a visitor on the gateway backend, I get the product page fetched over the gateway and written into the window', async () => {
    // Given a gateway that serves a single page
    const page = harness({ type: 'single', content: enc('<h1>hi</h1>') });

    // When the first attempt loads it
    const outcome = await loadProduct({ params: params(), attempt: 1 }, page.deps);

    // Then the page is written after the host hears it loaded, and the write is reported
    expect(outcome).toEqual({ outcome: 'loaded' });
    expect(page.fetches).toEqual([{ useGateway: true }]);
    expect(page.written).toEqual(['<h1>hi</h1>']);
    expect(page.events.slice(-2)).toEqual(['loaded', 'write']);
    expect(page.reports).toEqual([
      { event: 'document_written', flowId: 'flow-1', payload: { cid: CID, totalMs: 42, bytes: 11, fileCount: 1 } },
    ]);
  });

  it("As a visitor on a light client backend, I get the content fetched through the host's block relay", async () => {
    // Given a light client backend whose block source is the relay
    const page = harness({ type: 'single', content: enc('<h1>hi</h1>') }, { blockSource: BLOCK_SOURCE });

    // When the first attempt loads it
    const outcome = await loadProduct({ params: params({ chainBackend: 'smoldot-direct' }), attempt: 1 }, page.deps);

    // Then the fetch reads its blocks from the relay
    expect(outcome).toEqual({ outcome: 'loaded' });
    expect(page.fetches).toEqual([{ bitswapBlockSource: BLOCK_SOURCE }]);
  });

  it('As a visitor opening an archive, I get it handed to the service worker before its index is written', async () => {
    // Given an archive with an index and a script
    const files = { 'index.html': enc('<main>app</main>'), 'app.js': enc('run()') };
    const page = harness({ type: 'archive', files });

    // When the first attempt loads it
    const outcome = await loadProduct({ params: params(), attempt: 1 }, page.deps);

    // Then the worker holds the files before the index is written
    expect(outcome).toEqual({ outcome: 'loaded' });
    expect(page.stored).toEqual([files]);
    expect(page.written).toEqual(['<main>app</main>']);
    expect(page.events.indexOf('store')).toBeLessThan(page.events.indexOf('write'));
  });

  it('As a visitor opening encrypted content, I am served the files it decrypts to', async () => {
    // Given sealed content that decrypts to an archive
    const files = { 'index.html': enc('<p>secret</p>') };
    const page = harness({ type: 'single', content: enc('sealed') }, { decrypt: () => Promise.resolve(files) });

    // When the first attempt loads it
    const outcome = await loadProduct({ params: params(), attempt: 1 }, page.deps);

    // Then the decrypted archive is stored and its index written
    expect(outcome).toEqual({ outcome: 'loaded' });
    expect(page.stored).toEqual([files]);
    expect(page.written).toEqual(['<p>secret</p>']);
  });

  it('As an operator, I see an archive with no index.html fail at the archive index step', async () => {
    // Given an archive without an index
    const page = harness({ type: 'archive', files: { 'app.js': enc('run()') } });

    // When the first attempt loads it
    const outcome = await loadProduct({ params: params(), attempt: 1 }, page.deps);

    // Then nothing is written
    expect(outcome).toMatchObject({ outcome: 'failed', step: 'archive_index' });
    expect(page.written).toEqual([]);
  });

  it('As an operator, I see content that does not match its CID fail at the verify step', async () => {
    // Given a fetch that rejects the bytes it got
    const mismatch = Object.assign(new Error(`Content hash mismatch for ${CID}`), { name: 'ContentVerificationError' });
    const page = harness(mismatch);

    // When the first attempt loads it
    const outcome = await loadProduct({ params: params(), attempt: 1 }, page.deps);

    // Then the failure is the verification, not the fetch
    expect(outcome).toEqual({ outcome: 'failed', step: 'verify', error: mismatch });
  });

  it('As an operator, I see an unreachable gateway fail at the content fetch step', async () => {
    // Given a gateway the browser cannot reach
    const unreachable = new TypeError('Failed to fetch');
    const page = harness(unreachable);

    // When the first attempt loads it
    const outcome = await loadProduct({ params: params(), attempt: 1 }, page.deps);

    // Then the failure names the fetch
    expect(outcome).toEqual({ outcome: 'failed', step: 'content_fetch', error: unreachable });
  });

  it.each<[string, (broken: Error) => Partial<LoadProductDeps>, FetchResult]>([
    ['sw_register', broken => ({ registerWorker: () => Promise.reject(broken) }), { type: 'single', content: enc('') }],
    ['decrypt', broken => ({ decrypt: () => Promise.reject(broken) }), { type: 'single', content: enc('sealed') }],
    [
      'sw_store',
      broken => ({ storeArchive: () => Promise.reject(broken) }),
      { type: 'archive', files: { 'index.html': enc('<main>app</main>') } },
    ],
    [
      'render',
      broken => ({ prepareHtml: () => Promise.reject(broken) }),
      { type: 'single', content: enc('<p>hi</p>') },
    ],
  ])(
    'As an operator on a light client backend, I see a failure there reported at the %s step',
    async (step, breaks, fetched) => {
      // Given a light client load whose step throws
      const broken = new Error(`${step} broke`);
      const page = harness(fetched, { blockSource: BLOCK_SOURCE, ...breaks(broken) });

      // When the first attempt loads it
      const outcome = await loadProduct({ params: params({ chainBackend: 'smoldot-direct' }), attempt: 1 }, page.deps);

      // Then the failure names that step, and nothing is written
      expect(outcome).toEqual({ outcome: 'failed', step, error: broken });
      expect(page.written).toEqual([]);
    },
  );

  it('As a visitor leaving mid-load, I see a fetch the frame tore down end the load quietly', async () => {
    // Given a relay fetch aborted by the frame's teardown
    const page = harness(new Error('bitswap-relay: aborted, the sandbox frame was torn down'));

    // When the first attempt loads it
    const outcome = await loadProduct({ params: params({ chainBackend: 'smoldot-direct' }), attempt: 1 }, page.deps);

    // Then the load ends as torn down, not failed
    expect(outcome).toEqual({ outcome: 'torn_down' });
  });

  it('As a visitor asking for a full reset, I get the origin wiped and a fresh worker awaited on the first attempt only', async () => {
    // Given a full reset whose fetch fails
    const page = harness(new TypeError('Failed to fetch'));

    // When the first attempt fails and the visitor retries
    await loadProduct({ params: params({ fullReset: true }), attempt: 1 }, page.deps);
    await loadProduct({ params: params({ fullReset: true }), attempt: 2 }, page.deps);

    // Then only the first attempt purged, before its worker registered
    expect(page.events.filter(event => event === 'purge')).toHaveLength(1);
    expect(page.events.indexOf('purge')).toBeLessThan(page.events.indexOf('worker'));
    expect(page.workers).toEqual([{ waitForFreshController: true }, { waitForFreshController: false }]);
  });
});
