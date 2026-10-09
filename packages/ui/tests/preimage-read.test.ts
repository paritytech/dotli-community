// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blake2b } from '@noble/hashes/blake2.js';
import { createPreimageReadAdapter } from '../src/host-callbacks/PreimageRead.js';

const mocks = vi.hoisted(() => ({
  fetchFromIpfs: vi.fn(() => Promise.resolve({ data: new Uint8Array() })),
  bitswapGet: vi.fn(() => Promise.resolve(new Uint8Array())),
  getBackend: vi.fn(() => 'rpc-gateway'),
  getCacheNodeSettings: vi.fn(() => ({ enabled: true, providersUrl: 'http://set/providers', payerSeed: '' })),
}));

vi.mock('../../content/src/ipfs.js', () => ({ fetchFromIpfs: mocks.fetchFromIpfs }));
vi.mock('../../content/src/bitswap.js', () => ({ bitswapGet: mocks.bitswapGet }));
vi.mock('../../config/src/mode.js', () => ({
  getBackend: mocks.getBackend,
  getCacheNodeSettings: mocks.getCacheNodeSettings,
}));

const NODE = { id: '07'.repeat(32), api: 'http://cache-node', name: 'A', region: 'eu-west' };

/** A provider set with one cache node. `acquire` is that node's answer to a read. */
function stubNetwork(acquire: () => Response): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url === 'http://set/providers') {
      return Promise.resolve(Response.json([NODE]));
    }
    if (url === 'http://cache-node/acquire') {
      return Promise.resolve(acquire());
    }
    return Promise.resolve(Response.json('Charged'));
  });
  return urls;
}

/** A new value and its key, so that no test reads a value that another test left in the page cache. */
function fresh(text: string): { value: Uint8Array<ArrayBuffer>; key: Uint8Array; hex: string } {
  const value = new Uint8Array(new TextEncoder().encode(`${text} ${String(Math.random())}`));
  return { value, key: blake2b(value, { dkLen: 32 }), hex: `0x${Buffer.from(value).toString('hex')}` };
}

describe('Preimage.read host adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBackend.mockReturnValue('rpc-gateway');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('As a product that measures Bulletin, I read through the Bulletin route, and no cache node is asked', async () => {
    // Given a value that the gateway has
    const { value, key, hex } = fresh('bulletin');
    mocks.fetchFromIpfs.mockResolvedValue({ data: value });
    const urls = stubNetwork(() => new Response('', { status: 404 }));

    // When
    const answer = await createPreimageReadAdapter().readPreimage(key, { tag: 'Bulletin' }, true);

    // Then
    expect({
      value: answer.value,
      servedBy: answer.report.servedBy,
      attempts: answer.report.attempts.map(a => [a.source, a.outcome]),
      urls,
    }).toEqual({
      value: hex,
      servedBy: { tag: 'Bulletin', value: { via: 'Gateway' } },
      attempts: [[{ tag: 'Bulletin', value: { via: 'Gateway' } }, { tag: 'Served' }]],
      urls: [],
    });
  });

  it('As a product that shows the cache, I read through the Cache route and learn the node, its origin and its trace', async () => {
    // Given a cache node that fetched the value from Bulletin during the read
    const { value, key, hex } = fresh('cache');
    stubNetwork(
      () =>
        new Response(value, {
          status: 200,
          headers: { 'x-cache-origin': 'source', 'x-cache-elapsed-ms': '812', 'x-cache-trace': '{"steps":[]}' },
        }),
    );

    // When
    const answer = await createPreimageReadAdapter().readPreimage(key, { tag: 'Cache' }, true);

    // Then
    expect({
      value: answer.value,
      servedBy: answer.report.servedBy,
      outcomes: answer.report.attempts.map(a => a.outcome.tag),
      bulletin: mocks.fetchFromIpfs.mock.calls.length,
    }).toEqual({
      value: hex,
      servedBy: {
        tag: 'CacheProvider',
        value: {
          id: `0x${NODE.id}`,
          name: 'A',
          region: 'eu-west',
          origin: { tag: 'Source' },
          rank: 0,
          home: true,
          providerMs: 812,
          trace: '{"steps":[]}',
        },
      },
      outcomes: ['Served'],
      bulletin: 0,
    });
  });

  it('As a product on the Auto route, a cache miss falls back to Bulletin, and the report shows both tries', async () => {
    // Given a cache node without the value, and a gateway with it
    const { value, key } = fresh('auto');
    stubNetwork(() => new Response('not found', { status: 404 }));
    mocks.fetchFromIpfs.mockResolvedValue({ data: value });

    // When
    const answer = await createPreimageReadAdapter().readPreimage(key, { tag: 'Auto' }, true);

    // Then
    expect(answer.report.attempts.map(a => [a.source.tag, a.outcome.tag])).toEqual([
      ['CacheProvider', 'Miss'],
      ['Bulletin', 'Served'],
    ]);
  });

  it('As a product, a second read answers from the page cache unless I skip host caches', async () => {
    // Given a value that one read already found
    const { value, key } = fresh('host cache');
    mocks.fetchFromIpfs.mockResolvedValue({ data: value });
    stubNetwork(() => new Response('', { status: 404 }));
    const adapter = createPreimageReadAdapter();
    await adapter.readPreimage(key, { tag: 'Bulletin' }, true);

    // When
    const cached = await adapter.readPreimage(key, { tag: 'Bulletin' }, false);
    const skipped = await adapter.readPreimage(key, { tag: 'Bulletin' }, true);

    // Then
    expect([cached.report.servedBy, skipped.report.servedBy]).toEqual([
      { tag: 'HostCache' },
      { tag: 'Bulletin', value: { via: 'Gateway' } },
    ]);
  });

  it('As a product, I am told when the cache provider I name is not in the provider set', async () => {
    // Given
    const { key } = fresh('unknown');
    stubNetwork(() => new Response('', { status: 404 }));

    // When
    const read = createPreimageReadAdapter().readPreimage(
      key,
      { tag: 'CacheProvider', value: { id: `0x${'08'.repeat(32)}` } },
      true,
    );

    // Then
    await expect(read).rejects.toThrow('is not in the provider set');
  });
});
