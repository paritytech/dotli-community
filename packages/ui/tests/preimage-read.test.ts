// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blake2b } from '@noble/hashes/blake2.js';
import { createPreimageReadAdapter } from '../src/host-callbacks/PreimageRead.js';
import { parseInfo, spanOf } from '../../content/src/torrent.js';
import { threeFileTorrent } from '../../content/tests/torrent-fixture.js';

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

  it('As a product with a magnet link, I get the file of the torrent through a cache node, checked piece by piece', async () => {
    // Given a cache node that fetches file 2 of a torrent from the swarm
    const { info, infoHash, all } = await threeFileTorrent();
    const span = spanOf(parseInfo(info), 2);
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'http://set/providers') {
        return Promise.resolve(Response.json([NODE]));
      }
      if (url === 'http://cache-node/prefetch') {
        return Promise.resolve(Response.json({ state: 'done', downloaded: 0, peers: 0, elapsed_ms: 0 }));
      }
      if (url === 'http://cache-node/acquire') {
        return Promise.resolve(
          new Response(all.slice(span.start, span.end), { headers: { 'x-cache-origin': 'source' } }),
        );
      }
      if (url === `http://cache-node/torrent/${infoHash}`) {
        return Promise.resolve(new Response(info));
      }
      return Promise.resolve(Response.json('Charged'));
    });
    const adapter = createPreimageReadAdapter();

    // When the product reads the magnet link through the cache
    const answer = await adapter.readTorrent({
      magnet: `magnet:?xt=urn:btih:${infoHash}`,
      file: 2,
      route: { tag: 'Cache' },
    });

    // Then it gets the file, its name and index, and a report of the node that fetched it from the swarm
    const file = all.slice(400_008);
    expect({
      value: answer.value,
      name: answer.name,
      file: answer.file,
      servedBy: answer.report.servedBy,
    }).toEqual({
      value: `0x${Buffer.from(file).toString('hex')}`,
      name: 'dir/f2.bin',
      file: 2,
      servedBy: {
        tag: 'CacheProvider',
        value: { id: `0x${NODE.id}`, name: 'A', region: 'eu-west', origin: { tag: 'Source' }, rank: 0, home: true },
      },
    });
    // And the list of the files of the torrent, so the product can read the other files
    expect(answer.files.map(entry => [entry.index, entry.path.split('/').pop(), entry.size])).toEqual([
      [0, expect.any(String), 100_001n],
      [1, expect.any(String), 300_007n],
      [2, 'f2.bin', 50_003n],
    ]);
    // And a torrent is not on Bulletin
    await expect(
      adapter.readTorrent({ magnet: `magnet:?xt=urn:btih:${infoHash}`, route: { tag: 'Bulletin' } }),
    ).rejects.toThrow('not on Bulletin');
  });

  it('As a product, I get the progress of a torrent file that a cache node still downloads', async () => {
    // Given a cache node that downloads the file
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'http://set/providers') {
        return Promise.resolve(Response.json([NODE]));
      }
      if (url === 'http://cache-node/prefetch') {
        return Promise.resolve(
          Response.json({
            state: 'downloading',
            name: 'b.bin',
            size: 300_007,
            downloaded: 2_000,
            peers: 3,
            elapsed_ms: 1_500,
          }),
        );
      }
      return Promise.resolve(Response.json('Charged'));
    });

    // When the product reads the magnet link
    const answer = await createPreimageReadAdapter().readTorrent({
      magnet: `magnet:?xt=urn:btih:${'cd'.repeat(20)}&so=1`,
      route: { tag: 'Cache' },
    });

    // Then the answer has no value yet, and the progress of the node
    expect({ value: answer.value, name: answer.name, progress: answer.progress }).toEqual({
      value: undefined,
      name: 'b.bin',
      progress: {
        provider: `0x${NODE.id}`,
        state: 'Downloading',
        size: 300_007n,
        downloaded: 2_000n,
        peers: 3,
        elapsedMs: 1_500n,
      },
    });
  });

  it('As a product, I read a torrent file in parts, and the host reads it from the node once', async () => {
    // Given a cache node that has file 1 of a torrent
    const { info, infoHash, all } = await threeFileTorrent();
    const span = spanOf(parseInfo(info), 1);
    const reads: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      reads.push(url);
      if (url === 'http://set/providers') {
        return Promise.resolve(Response.json([NODE]));
      }
      if (url === 'http://cache-node/prefetch') {
        return Promise.resolve(Response.json({ state: 'done', downloaded: 0, peers: 0, elapsed_ms: 0 }));
      }
      if (url === 'http://cache-node/acquire') {
        return Promise.resolve(new Response(all.slice(span.start, span.end)));
      }
      if (url === `http://cache-node/torrent/${infoHash}`) {
        return Promise.resolve(new Response(info));
      }
      return Promise.resolve(Response.json('Charged'));
    });
    const adapter = createPreimageReadAdapter();
    const magnet = `magnet:?xt=urn:btih:${infoHash}&so=1`;
    const file = all.slice(100_001, 400_008);

    // When the product reads two parts of the file
    const first = await adapter.readTorrent({ magnet, route: { tag: 'Cache' }, range: { offset: 0n, length: 1000 } });
    const second = await adapter.readTorrent({
      magnet,
      route: { tag: 'Cache' },
      range: { offset: 300_000n, length: 1000 },
    });

    // Then each part has its bytes, the key and the size of the whole file, and only one read went to the node
    const key = `0x${Buffer.from(blake2b(file, { dkLen: 32 })).toString('hex')}`;
    expect({
      first: [first.value, first.key, first.size],
      second: [second.value, second.key, second.size],
      reads: reads.filter(url => url.endsWith('/acquire')).length,
    }).toEqual({
      first: [`0x${Buffer.from(file.slice(0, 1000)).toString('hex')}`, key, 300_007n],
      second: [`0x${Buffer.from(file.slice(300_000)).toString('hex')}`, key, 300_007n],
      reads: 1,
    });
  });
});
