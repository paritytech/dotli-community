// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blake2b } from '@noble/hashes/blake2.js';
import { createPreimageReadAdapter } from '../src/host-callbacks/PreimageRead.js';
import { hashToCid } from '../../content/src/preimage.js';
import { payerFromSeed } from '../../content/src/cache-nodes.js';
import { setDotNameResolver } from '../src/host-callbacks/dot-names.js';
import { parseInfo, spanOf } from '../../content/src/torrent.js';
import { threeFileTorrent } from '../../content/tests/torrent-fixture.js';

const mocks = vi.hoisted(() => ({
  showPreimageRetainModal: vi.fn((_review: unknown) => Promise.resolve(true)),
  fetchFromIpfs: vi.fn(() => Promise.resolve({ data: new Uint8Array() })),
  bitswapGet: vi.fn(() => Promise.resolve(new Uint8Array())),
  getBackend: vi.fn(() => 'rpc-gateway'),
  getCacheNodeSettings: vi.fn(() => ({
    enabled: true,
    registry: '',
    providersUrl: 'http://set/providers',
    payerSeed: '',
  })),
}));

vi.mock('../src/preimage-modal.js', () => ({ showPreimageRetainModal: mocks.showPreimageRetainModal }));
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

describe('Preimage.retain host adapter', () => {
  // A modal scope that shows each modal at once.
  const scope = {
    enqueue: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
    dispose: () => undefined,
  };
  const key = `0x${'ab'.repeat(32)}` as const;
  const item = {
    target: { tag: 'Key' as const, value: key },
    periodSecs: 3600n,
    size: 3_000_000n,
    renew: false,
  };
  const request = { items: [item], dryRun: false };

  /** One cache node with a ledger account; `pin` is its answer to a pin. The bodies of the pins go to the list. */
  function stubNode(pin: () => Response): unknown[] {
    const pins: unknown[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'http://set/providers') {
        return Promise.resolve(Response.json([NODE]));
      }
      if (url.startsWith('http://cache-node/account/')) {
        return Promise.resolve(
          Response.json({
            balance: 580,
            price: 10,
            retention_price: 1,
            allowance: 480,
            allowance_retention: 48,
            paid: 100,
          }),
        );
      }
      pins.push(JSON.parse(init?.body as string));
      return Promise.resolve(pin());
    });
    return pins;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.showPreimageRetainModal.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('As a person, I see the size, the period, the node and the price, and after I accept the node keeps the file', async () => {
    // Given a node that keeps the file and its 2 chunks for 3 credits
    const pins = stubNode(() =>
      Response.json({
        node: 'A',
        id: 'x',
        size: 3_000_000,
        origin: 'source',
        failed_peers: [],
        until: 99,
        charged: 3,
        chunks: 2,
      }),
    );

    // When the product asks to keep a 3 MB file for an hour
    const kept = await createPreimageReadAdapter('cache-demo.paseo', scope).retainPreimage(request);

    // Then the modal showed the price from the free allowance, one pin went out, and the answer names the node
    expect({ review: mocks.showPreimageRetainModal.mock.calls[0]?.[0], pins: pins.length, kept }).toEqual({
      review: {
        label: 'cache-demo.paseo',
        items: [{ size: 3_000_000, periodSecs: 3600, node: 'A, eu-west', price: 3 }],
        funds: { free: 48, paid: 100 },
      },
      pins: 1,
      kept: {
        items: [
          {
            cid: hashToCid(key).toString(),
            provider: `0x${NODE.id}`,
            name: 'A',
            region: 'eu-west',
            kind: 'File',
            size: 3_000_000n,
            pieces: 3,
            until: 99n,
            price: 3n,
            charged: 3n,
            free: 3n,
            paid: 0n,
            short: 0n,
            renews: false,
            state: { tag: 'Kept' },
          },
        ],
      },
    });
  });

  it('As a product, a dry run gives me the node and the price, and the person sees nothing and pays nothing', async () => {
    // Given
    const pins = stubNode(() => Response.json({}));

    // When the product asks for the price of a day on the node of the user agent's choice
    const quote = await createPreimageReadAdapter('keepcached.paseo', scope).retainPreimage({
      items: [{ ...item, periodSecs: 86_400n }],
      dryRun: true,
    });

    // Then 3 MiB for 24 started hours is 72 credits: 48 from the free allowance and 24 paid
    expect({ shown: mocks.showPreimageRetainModal.mock.calls.length, pins, quote: quote.items[0] }).toMatchObject({
      shown: 0,
      pins: [],
      quote: {
        provider: `0x${NODE.id}`,
        price: 72n,
        charged: 0n,
        free: 48n,
        paid: 24n,
        short: 0n,
        state: { tag: 'Quote' },
      },
    });
  });

  it('As a person who declines, nothing is paid, and the product learns that I declined', async () => {
    // Given
    const pins = stubNode(() => Response.json({}));
    mocks.showPreimageRetainModal.mockResolvedValue(false);

    // When
    const kept = createPreimageReadAdapter('cache-demo.paseo', scope).retainPreimage(request);

    // Then
    await expect(kept).rejects.toThrow(/^Declined/);
    expect(pins).toEqual([]);
  });

  it('As a product, I learn that the payer cannot pay, or that the period is too long, from the start of the error', async () => {
    // Given a node that refuses the payer, then the period
    stubNode(() => new Response('refused: payer ab has 0 credits', { status: 402 }));
    const adapter = createPreimageReadAdapter('cache-demo.paseo', scope);
    await expect(adapter.retainPreimage(request)).rejects.toThrow(/^NotAvailable/);
    stubNode(
      () =>
        new Response("rejected: a pin ends 1 to 1209600 seconds after the node's clock 5, not at 9", { status: 400 }),
    );
    await expect(adapter.retainPreimage(request)).rejects.toThrow(/^PeriodTooLong: .*at most 1209600 s/);
  });
});

describe('Preimage leases by the day', () => {
  const scope = {
    enqueue: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
    dispose: () => undefined,
  };
  const key = `0x${'cd'.repeat(32)}` as const;
  const cid = hashToCid(key).toString();
  // A ledger that prices retention by the MiB-day (2 credits) and reads by the MiB (1 credit).
  const quote = {
    balance: 580,
    price: 10,
    read_price_per_mib: 1,
    retention_price: 2,
    retention_unit_secs: 86_400,
    allowance: 480,
    allowance_retention: 48,
    paid: 100,
  };

  /**
   * One cache node with that ledger. It keeps a pin until `paidUntil`, stops leases, and lists one lease that renews.
   * The bodies of the posts go to the list.
   */
  function stubLedger(paidUntil: number, renews = true): { url: string; body: Record<string, unknown> }[] {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    let stopped = false;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'http://set/providers') {
        return Promise.resolve(Response.json([NODE]));
      }
      if (url.startsWith('http://cache-node/account/')) {
        return Promise.resolve(Response.json(quote));
      }
      if (url.startsWith('http://cache-node/pin-state/')) {
        return Promise.resolve(Response.json({ state: 'kept', blocks: 1 }));
      }
      posts.push({ url, body: JSON.parse(init?.body as string) as Record<string, unknown> });
      if (url === 'http://cache-node/leases/stop') {
        stopped = true;
        return Promise.resolve(Response.json({ stopped: 1 }));
      }
      if (url === 'http://cache-node/leases') {
        const daily = renews && !stopped;
        return Promise.resolve(
          Response.json({
            payer: (posts.at(-1)?.body['request'] as { payer: string }).payer,
            leases: [
              {
                content: cid,
                provider: NODE.id,
                from: 1000,
                until: paidUntil,
                size: 3_000_000,
                charged: 6,
                paid_until: paidUntil,
                per_day: daily ? 6 : 0,
                renews: daily,
              },
            ],
          }),
        );
      }
      return Promise.resolve(Response.json({ until: paidUntil, size: 3_000_000, chunks: 0, charged: 6 }));
    });
    return posts;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.showPreimageRetainModal.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('As a product, I learn the units of the prices of the ledger', async () => {
    // Given
    stubLedger(0);

    // When
    const account = await createPreimageReadAdapter().cacheAccount({});

    // Then
    expect(account).toMatchObject({
      readPrice: 10n,
      readPricePerMib: 1n,
      retentionPrice: 2n,
      retentionUnitSecs: 86_400n,
    });
  });

  it('As a person, I see the price of a day of a lease that renews until I stop it, and after I accept the node charges the first day', async () => {
    // Given a node that keeps the file until the end of the first day
    const now = Math.floor(Date.now() / 1000);
    const posts = stubLedger(now + 86_400);
    const adapter = createPreimageReadAdapter('keepcached.paseo', scope);
    const item = { target: { tag: 'Key' as const, value: key }, periodSecs: 0n, size: 3_000_000n, renew: true };

    // When the product asks for the price, then keeps the file with a lease without an end
    const dry = await adapter.retainPreimage({ items: [item], dryRun: true });
    const kept = await adapter.retainPreimage({ items: [item], dryRun: false });

    // Then 3 started MiB cost 6 credits a day, the modal says so, and the pin is a lease for at most 6 credits a day
    const pin = posts.find(post => post.url === 'http://cache-node/pin');
    const receipt = (pin?.body['authorization'] as { receipt: Record<string, unknown> }).receipt;
    const quoted = dry.items[0];
    expect({
      dry: quoted && { price: quoted.price, renews: quoted.renews, free: quoted.free, state: quoted.state },
      dryDay: quoted && Number(quoted.until) - now >= 86_400 && Number(quoted.until) - now < 86_400 + 60,
      review: mocks.showPreimageRetainModal.mock.calls[0]?.[0],
      receipt: [receipt['service'], receipt['until'], receipt['max_per_day']],
      kept: kept.items[0] && {
        price: kept.items[0].price,
        until: kept.items[0].until,
        charged: kept.items[0].charged,
        renews: kept.items[0].renews,
      },
    }).toEqual({
      dry: { price: 6n, renews: true, free: 6n, state: { tag: 'Quote' } },
      dryDay: true,
      review: {
        label: 'keepcached.paseo',
        items: [{ size: 3_000_000, periodSecs: 0, renews: true, node: 'A, eu-west', price: 6 }],
        funds: { free: 48, paid: 100 },
      },
      receipt: ['Lease', 0, 6],
      kept: { price: 6n, until: BigInt(now + 86_400), charged: 6n, renews: true },
    });
  });

  it('As a person, I see my lease that renews, and when I stop it the node keeps my file to the end of the paid day', async () => {
    // Given a lease that renews and is paid for one more day
    const paidUntil = Math.floor(Date.now() / 1000) + 86_400;
    const posts = stubLedger(paidUntil);
    const adapter = createPreimageReadAdapter('keepcached.paseo', scope);

    // When the product lists the retentions, then stops the lease
    const before = await adapter.retentions({});
    const stopped = await adapter.stopRetention({ cid, provider: `0x${NODE.id}` });

    // Then the list has the paid days and the price of a day, and the stop request named the node and the content
    const stop = posts.find(post => post.url === 'http://cache-node/leases/stop')?.body['request'] as
      { provider: string; content: string } | undefined;
    expect({
      before: before.retentions.map(r => [r.paidUntil, r.perDay, r.renews, r.until]),
      stop: stop && [stop.provider, stop.content],
      until: stopped.until,
    }).toEqual({
      before: [[BigInt(paidUntil), 6n, true, BigInt(paidUntil)]],
      stop: [NODE.id, cid],
      until: BigInt(paidUntil),
    });
  });

  it('As a product, I learn that a stop needs a node of the provider set', async () => {
    // Given
    stubLedger(0);

    // When
    const stopped = createPreimageReadAdapter().stopRetention({ cid, provider: `0x${'08'.repeat(32)}` });

    // Then
    await expect(stopped).rejects.toThrow(/^Failed: .*not in the provider set/);
  });
});

describe('Preimage.cacheProviders host adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('As a person who picks a node, I see each node with its place and whether it is a home node of my item', async () => {
    // Given one cache node in the provider set
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        url === 'http://set/providers' ? Response.json([NODE]) : new Response('', { status: 404 }),
      );
    });

    // When the product asks for the nodes of a key
    const answer = await createPreimageReadAdapter().cacheProviders({
      target: { tag: 'Key', value: `0x${'ab'.repeat(32)}` },
    });

    // Then the only node is a home node of every content (the time that the host measured depends on earlier reads)
    expect(answer).toMatchObject({
      providers: [
        { id: `0x${NODE.id}`, name: 'A', region: 'eu-west', source: 'Registry', home: true, failedRecently: false },
      ],
    });
  });
});

describe('Preimage.retain of a site', () => {
  // The root block of the site cache-demo.paseo (see packages/content/tests/cache-nodes.test.ts).
  const root = Uint8Array.from(
    Buffer.from(
      '122b0a2401551220790e8fe960819b22c3e0aa271bf9f60b060e6ac93aa627cde27885ea897f92a5120018a50c122c0a2401551220b2e01a32e5ca22d806c76069e53d8986f3767e513de1e4d501b7bb47cfb4f342120018d4fa0e122b0a240155122018658392ed83c55d5e0e31e3c8c3eb2bbbde991e6064fefac153f93061652b221200188e070a10080218878e0f20a50c20d4fa0e208e07',
      'hex',
    ),
  );
  const site = 'bafybeicepvbzj6i4yflvozwz464yxasywzpf6uvabuz5ol2bs3johuoxxe';
  const scope = {
    enqueue: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
    dispose: () => undefined,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('As a person, the user agent prices a site by its name from its root block, and keeps nothing in a dry run', async () => {
    // Given a name that resolves to the site, a node that does not have it yet, and Bulletin that has its root block
    setDotNameResolver(label => Promise.resolve(label === 'cache-demo' ? site : null));
    mocks.fetchFromIpfs.mockImplementation(() => Promise.resolve({ data: root }));
    const posts: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'http://set/providers') {
        return Promise.resolve(Response.json([NODE]));
      }
      if (url.startsWith('http://cache-node/account/')) {
        return Promise.resolve(
          Response.json({
            balance: 580,
            price: 10,
            retention_price: 1,
            allowance: 480,
            allowance_retention: 48,
            paid: 100,
          }),
        );
      }
      posts.push(url);
      return Promise.resolve(new Response('', { status: 404 }));
    });

    // When the product asks for the price of a day of the site, by its name
    const quote = await createPreimageReadAdapter('keepcached.paseo', scope).retainPreimage({
      items: [
        {
          target: { tag: 'DotNs', value: 'cache-demo.paseo' },
          periodSecs: 86_400n,
          renew: false,
        },
      ],
      dryRun: true,
    });

    // Then the site is its root and three chunks, 247 713 bytes: 1 started MiB for 24 hours, and nothing was pinned
    expect({ quote: quote.items[0], pins: posts.filter(url => url.endsWith('/pin')) }).toMatchObject({
      quote: { cid: site, kind: 'File', size: 247_713n, pieces: 4, price: 24n, free: 24n, state: { tag: 'Quote' } },
      pins: [],
    });
  });

  it('As a person, a name without content is not found', async () => {
    setDotNameResolver(() => Promise.resolve(null));
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json([NODE])));
    const quote = createPreimageReadAdapter('keepcached.paseo', scope).retainPreimage({
      items: [
        {
          target: { tag: 'DotNs', value: 'nothing.paseo' },
          periodSecs: 3600n,
          renew: false,
        },
      ],
      dryRun: true,
    });
    await expect(quote).rejects.toThrow(/^NotFound/);
  });
});

describe('the cache payer of a product', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('As a signed-in person, the user agent pays for my product with the payer that the core gives, else with the shared one', async () => {
    // Given a node with a ledger that answers every account
    const asked: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'http://set/providers') {
        return Promise.resolve(Response.json([NODE]));
      }
      asked.push(url);
      return Promise.resolve(Response.json({ balance: 0, price: 10, retention_price: 1 }));
    });
    const adapter = createPreimageReadAdapter('keepcached.paseo');
    const seed = new Uint8Array(32).fill(5);

    // When the core sets the payer of the person, then clears it at a sign-out
    await adapter.setCachePayer(seed);
    const mine = await adapter.cacheAccount({});
    await adapter.setCachePayer(new Uint8Array());
    const shared = await adapter.cacheAccount({});

    // Then the account of the person is that payer, and without a person it is the shared payer
    const own = payerFromSeed(seed).id;
    expect([mine.payer, asked[0]?.endsWith(own), shared.payer === mine.payer]).toEqual([`0x${own}`, true, false]);
  });
});
