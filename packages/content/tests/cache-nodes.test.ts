// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { blake2b } from '@noble/hashes/blake2.js';
import { verify } from '@scure/sr25519';
import { describe, it, expect } from 'vitest';

import {
  CacheNodes,
  dagSize,
  enrollMessage,
  homeNodes,
  leaseDayPrice,
  leaseMessage,
  leasesMessage,
  orderProviders,
  parseOrigin,
  payerFromSeed,
  pinError,
  rawTwin,
  readMessage,
  readPrice,
  receiptMessage,
  rendezvousScore,
  retentionMessage,
  retentionPrice,
  stopMessage,
  testPayerSeed,
  type CacheProvider,
  type CacheQuality,
} from '../src/cache-nodes.js';
import { parseInfo, spanOf } from '../src/torrent.js';
import { threeFileTorrent } from './torrent-fixture.js';

const toHex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], pair => parseInt(pair, 16));
const CID = 'bafk2bzaceb2yf3stdn7wptwblupjbssdhdp2czormoqyiwkcrq35uhvzgcgp4';
const SEVENS = '07'.repeat(32);

describe('cache node messages', () => {
  // The cache (src/payment.rs, src/logic.rs) and the CLI host (cache_lookup.rs) have the same vectors.
  it('As a user agent that pays cache nodes, I derive the same payer and sign the same bytes as the cache and the CLI host', () => {
    // Given the payer of the seed [1; 32] and the provider [7; 32]
    const payer = payerFromSeed(new Uint8Array(32).fill(1));
    const fields = { transfer: 't-1', payer: payer.id, provider: SEVENS, content: CID };

    // When the host encodes the messages
    const shared = `03000000742d31${payer.id}${SEVENS}3e000000${toHex(new TextEncoder().encode(CID))}`;

    // Then they are the shared vectors
    expect({
      payer: payer.id,
      score: toHex(rendezvousScore(CID, SEVENS)),
      read: toHex(readMessage({ ...fields, issuedAt: 1_791_500_000 })),
      receipt: toHex(receiptMessage({ ...fields, size: 0 })),
      retention: toHex(retentionMessage({ ...fields, size: 1 << 20, from: 1000, until: 4600 })),
      lease: toHex(leaseMessage({ ...fields, size: 1 << 20, from: 1000, until: 0, maxPerDay: 5 })),
      stop: toHex(stopMessage({ payer: payer.id, provider: SEVENS, content: CID, issuedAt: 1_790_000_000 })),
    }).toEqual({
      payer: '189dac29296d31814dc8c56cf3d36a0543372bba7538fa322a4aebfebc39e056',
      score: '1b90bef8509cc25b45d94885d8a1eca44bd751212310efc75c9e2628a663b98f',
      read: `63616368652d726561642f31${shared}e01ec86a00000000`,
      receipt: `63616368652d726563656970742f32${shared}${'00'.repeat(25)}`,
      retention: `63616368652d726563656970742f32${shared}010000100000000000e803000000000000f811000000000000`,
      lease: `63616368652d726563656970742f33${shared}020000100000000000e80300000000000000000000000000000500000000000000`,
      stop: `63616368652d73746f702f31${payer.id}${SEVENS}3e000000${toHex(new TextEncoder().encode(CID))}803bb16a00000000`,
    });
  });

  it('As a user agent, I read the origin a cache node reports, and treat anything else as unknown', () => {
    expect(['local', 'source', `peer:${SEVENS}`, 'peer:abc', null].map(parseOrigin)).toEqual([
      { kind: 'local' },
      { kind: 'source' },
      { kind: 'peer', id: SEVENS },
      { kind: 'unknown' },
      { kind: 'unknown' },
    ]);
  });
});

const provider = (n: number): CacheProvider => ({
  id: n.toString(16).padStart(2, '0').repeat(32),
  api: `http://node-${String(n)}`,
});

describe('provider order', () => {
  it('As a user agent, I ask failing providers last, home nodes at half their latency, and explore an unmeasured one', () => {
    // Given four providers: 1 is fast, 2 is slow but a home node, 3 failed a moment ago, 4 is unmeasured
    const [a, b, c, d] = [provider(1), provider(2), provider(3), provider(4)];
    const now = 1_000_000;
    const quality = new Map<string, CacheQuality>([
      [a.id, { latencyMs: 30, successes: 1, failures: 0 }],
      [b.id, { latencyMs: 40, successes: 1, failures: 0 }],
      [c.id, { latencyMs: 5, successes: 1, failures: 1, failedAt: now - 1000 }],
    ]);

    // When the host orders them, without and with exploration
    const ids = (list: CacheProvider[]): string[] => list.map(p => p.api);
    const plain = ids(orderProviders([a, b, c, d], [b.id], quality, false, now));
    const exploring = ids(orderProviders([a, b, c, d], [b.id], quality, true, now));

    // Then the home node (40 / 2 = 20 ms) beats the fast one, the unmeasured one counts 50 ms, and the failed one is
    // last
    expect({ plain, exploring }).toEqual({
      plain: ['http://node-2', 'http://node-1', 'http://node-4', 'http://node-3'],
      exploring: ['http://node-4', 'http://node-2', 'http://node-1', 'http://node-3'],
    });
  });
});

describe('CacheNodes.read', () => {
  it('As a user agent, I skip a node that misses and a node that sends bad bytes, pay the node that serves, and report each try', async () => {
    // Given three nodes in provider order: one misses, one sends bad bytes, and one serves the value from a peer
    const value = new TextEncoder().encode('cache put test');
    const key = blake2b(value, { dkLen: 32 });
    const [missing, liar, holder] = [provider(1), provider(2), provider(3)];
    const requests: { url: string; body: unknown }[] = [];
    const answer = (url: string): Response => {
      switch (url) {
        case 'http://set/providers':
          return Response.json([missing, liar, holder]);
        case 'http://node-1/acquire':
          return new Response('not found: no such blob', { status: 404 });
        case 'http://node-2/acquire':
          return new Response(new TextEncoder().encode('forged'), { status: 200 });
        case 'http://node-3/acquire':
          return new Response(value, {
            status: 200,
            headers: {
              'x-cache-origin': `peer:${SEVENS}`,
              'x-cache-elapsed-ms': '12',
              'x-cache-trace': '{"steps":[]}',
              'x-cache-price': '10',
            },
          });
        default:
          return Response.json('Charged');
      }
    };
    const fakeFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return Promise.resolve(answer(url));
    }) as typeof fetch;
    const quality = new Map<string, CacheQuality>([
      [missing.id, { latencyMs: 1, successes: 1, failures: 0 }],
      [liar.id, { latencyMs: 2, successes: 1, failures: 0 }],
      [holder.id, { latencyMs: 3, successes: 1, failures: 0 }],
    ]);
    const cache = new CacheNodes({
      providersUrl: 'http://set/providers',
      payerSeed: testPayerSeed('dotli'),
      fetch: fakeFetch,
      storage: { getItem: () => JSON.stringify(Object.fromEntries(quality)), setItem: () => undefined },
    });

    // When the host reads the key
    const read = await cache.read(key, CID);
    await new Promise(resolve => setTimeout(resolve, 0));

    // Then the third node served it, and only it got a receipt, with the payer's signature over the receipt message
    const receipt = requests.find(r => r.url.endsWith('/receipt'));
    const body = receipt?.body as { receipt: { transfer: string; size: number }; signature: string };
    const message = receiptMessage({
      transfer: body.receipt.transfer,
      payer: cache.payer.id,
      provider: holder.id,
      content: CID,
      size: value.length,
    });
    expect({
      value: read.value && new TextDecoder().decode(read.value),
      outcomes: read.attempts.map(a => `${a.provider.api}:${a.outcome}`),
      served: read.served && {
        api: read.served.provider.api,
        origin: read.served.origin,
        rank: read.served.rank,
        providerMs: read.served.providerMs,
        trace: read.served.trace,
        price: read.served.price,
      },
      receipts: requests.filter(r => r.url.endsWith('/receipt')).map(r => r.url),
      size: body.receipt.size,
      signed: verify(message, fromHex(body.signature), fromHex(cache.payer.id)),
    }).toEqual({
      value: 'cache put test',
      outcomes: ['http://node-1:miss', 'http://node-2:bad-bytes', 'http://node-3:served'],
      served: {
        api: 'http://node-3',
        origin: { kind: 'peer', id: SEVENS },
        rank: 2,
        providerMs: 12,
        trace: '{"steps":[]}',
        price: 10,
      },
      receipts: ['http://node-3/receipt'],
      size: value.length,
      signed: true,
    });
  });
});

describe('CacheNodes.account', () => {
  it('As a user agent, I give the account of the payer from the ledger of the first node, also from a ledger without allowances', async () => {
    // Given two nodes: the first in quality order has a ledger with allowances, the other an older ledger
    const [first, older] = [provider(1), provider(2)];
    const asked: string[] = [];
    const fakeFetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      asked.push(url);
      if (url === 'http://set/providers') {
        return Promise.resolve(Response.json([older, first]));
      }
      return Promise.resolve(
        url.startsWith('http://node-1/')
          ? Response.json({
              balance: 580,
              price: 10,
              retention_price: 1,
              allowance: 480,
              allowance_retention: 48,
              paid: 100,
              allowance_per_day: 500,
              retention_allowance_per_day: 48,
              day: 20740,
              read_price_per_mib: 2,
              retention_unit_secs: 86_400,
            })
          : Response.json({ balance: 940, price: 10, retention_price: 1 }),
      );
    }) as typeof fetch;
    const quality = new Map<string, CacheQuality>([
      [first.id, { latencyMs: 1, successes: 1, failures: 0 }],
      [older.id, { latencyMs: 9, successes: 1, failures: 0 }],
    ]);
    const cache = new CacheNodes({
      providersUrl: 'http://set/providers',
      payerSeed: testPayerSeed('dotli'),
      fetch: fakeFetch,
      storage: { getItem: () => JSON.stringify(Object.fromEntries(quality)), setItem: () => undefined },
    });

    // When the host asks for the account, then for the account at the older node
    const account = await cache.account();
    const atOlder = await cache.account({ only: older.id });

    // Then the first node answers with both tiers, and an older ledger gives its balance as paid credits
    expect({
      asked: asked.filter(url => url.includes('/account/')),
      first: { ...account, provider: account.provider.api },
      older: {
        paid: atOlder.paid,
        allowance: atOlder.allowance,
        readPrice: atOlder.readPrice,
        readPricePerMib: atOlder.readPricePerMib,
        retentionUnitSecs: atOlder.retentionUnitSecs,
      },
    }).toEqual({
      asked: [`http://node-1/account/${cache.payer.id}`, `http://node-2/account/${cache.payer.id}`],
      first: {
        payer: cache.payer.id,
        provider: 'http://node-1',
        allowance: 480,
        allowanceRetention: 48,
        paid: 100,
        allowancePerDay: 500,
        retentionAllowancePerDay: 48,
        readPrice: 10,
        readPricePerMib: 2,
        retentionPrice: 1,
        retentionUnitSecs: 86_400,
      },
      older: { paid: 940, allowance: 0, readPrice: 10, readPricePerMib: 0, retentionUnitSecs: 3600 },
    });
  });
});

describe('torrent reads through cache nodes', () => {
  it('As a user agent, I read a torrent file from a magnet link, check its pieces, and pay only the node that sent good bytes', async () => {
    // Given a torrent of three files, a node that sends a span with one changed byte, and a node that sends the right span
    const { info, infoHash, all } = await threeFileTorrent();
    const span = spanOf(parseInfo(info), 1);
    const good = all.slice(span.start, span.end);
    const bad = good.slice();
    bad[10] = (bad[10] ?? 0) ^ 1;
    const [liar, holder] = [provider(1), provider(2)];
    const requests: { url: string; body: unknown }[] = [];
    const answer = (url: string): Response => {
      switch (url) {
        case 'http://set/providers':
          return Response.json([liar, holder]);
        case 'http://node-1/prefetch':
        case 'http://node-2/prefetch':
          return Response.json({ state: 'done', downloaded: 0, peers: 0, elapsed_ms: 0 });
        case 'http://node-1/acquire':
          return new Response(bad, { status: 200 });
        case 'http://node-2/acquire':
          return new Response(good, { status: 200, headers: { 'x-cache-origin': 'source' } });
        case `http://node-1/torrent/${infoHash}`:
        case `http://node-2/torrent/${infoHash}`:
          return new Response(info, { status: 200 });
        default:
          return Response.json('Charged');
      }
    };
    const fakeFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return Promise.resolve(answer(url));
    }) as typeof fetch;
    const quality = new Map<string, CacheQuality>([
      [liar.id, { latencyMs: 1, successes: 1, failures: 0 }],
      [holder.id, { latencyMs: 2, successes: 1, failures: 0 }],
    ]);
    const cache = new CacheNodes({
      providersUrl: 'http://set/providers',
      payerSeed: testPayerSeed('dotli'),
      fetch: fakeFetch,
      storage: { getItem: () => JSON.stringify(Object.fromEntries(quality)), setItem: () => undefined },
    });

    // When the host reads file 1 of the magnet link
    const read = await cache.readTorrent(`magnet:?xt=urn:btih:${infoHash}&so=1`);
    await new Promise(resolve => setTimeout(resolve, 0));

    // Then the second node served the file, the read requests named the torrent id, and only the second node got a receipt
    const acquire = requests.find(r => r.url === 'http://node-2/acquire')?.body as {
      reference: { source: string; file: number };
      read: { request: { content: string } };
    };
    expect({
      value: read.value?.length,
      same: read.value?.every((byte, i) => byte === all[100_001 + i]),
      name: read.name,
      contentId: read.contentId,
      outcomes: read.attempts.map(a => `${a.provider.api}:${a.outcome}`),
      content: acquire.read.request.content,
      file: acquire.reference.file,
      receipts: requests.filter(r => r.url.endsWith('/receipt')).map(r => r.url),
      paidSize: (requests.find(r => r.url.endsWith('/receipt'))?.body as { receipt: { size: number } }).receipt.size,
    }).toEqual({
      value: 300_007,
      same: true,
      name: 'dir/f1.bin',
      contentId: `bt:${infoHash}:1`,
      outcomes: ['http://node-1:bad-bytes', 'http://node-2:served'],
      content: `bt:${infoHash}:1`,
      file: 1,
      receipts: ['http://node-2/receipt'],
      paidSize: good.length,
    });
  });

  it('As a user agent, I show the progress of a torrent file that a node still downloads, and ask that node again', async () => {
    // Given two nodes, and the first one in quality order starts the download and reports its progress
    const [first, second] = [provider(1), provider(2)];
    const requests: string[] = [];
    let downloaded = 1_000;
    const fakeFetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      if (url === 'http://set/providers') {
        return Promise.resolve(Response.json([first, second]));
      }
      if (url.endsWith('/prefetch')) {
        downloaded *= 2;
        return Promise.resolve(
          Response.json({ state: 'downloading', name: 'b.bin', size: 300_007, downloaded, peers: 3, elapsed_ms: 1500 }),
        );
      }
      return Promise.resolve(Response.json('Charged'));
    }) as typeof fetch;
    const quality = new Map<string, CacheQuality>([
      [first.id, { latencyMs: 1, successes: 1, failures: 0 }],
      [second.id, { latencyMs: 2, successes: 1, failures: 0 }],
    ]);
    const cache = new CacheNodes({
      providersUrl: 'http://set/providers',
      payerSeed: testPayerSeed('dotli'),
      fetch: fakeFetch,
      storage: { getItem: () => JSON.stringify(Object.fromEntries(quality)), setItem: () => undefined },
    });
    const magnet = `magnet:?xt=urn:btih:${'ab'.repeat(20)}&so=1`;

    // When the host reads the magnet link two times
    const once = await cache.readTorrent(magnet);
    const twice = await cache.readTorrent(magnet);

    // Then each answer has no value and the progress of the first node, and no read went to a node
    expect({
      value: [once.value, twice.value],
      progress: [once.progress, twice.progress].map(
        p => p && { api: p.provider.api, state: p.state, downloaded: p.downloaded },
      ),
      name: twice.progress?.name,
      reads: requests.filter(url => url.endsWith('/acquire')).length,
    }).toEqual({
      value: [undefined, undefined],
      progress: [
        { api: 'http://node-1', state: 'downloading', downloaded: 2_000 },
        { api: 'http://node-1', state: 'downloading', downloaded: 4_000 },
      ],
      name: 'b.bin',
      reads: 0,
    });
  });

  it('As a user agent, I show the bytes that came while a large torrent file comes from a node, and then give the file', async () => {
    // Given a node that has file 1, and sends the first 64 KiB of its span, then the rest only later
    const { info, infoHash, all } = await threeFileTorrent();
    const span = spanOf(parseInfo(info), 1);
    const good = all.slice(span.start, span.end);
    let rest: () => void = () => undefined;
    const later = new Promise<void>(resolve => {
      rest = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(good.slice(0, 65_536));
        await later;
        controller.enqueue(good.slice(65_536));
        controller.close();
      },
    });
    const node = provider(1);
    const requests: string[] = [];
    const fakeFetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      switch (url) {
        case 'http://set/providers':
          return Promise.resolve(Response.json([node]));
        case 'http://node-1/prefetch':
          return Promise.resolve(Response.json({ state: 'done', downloaded: 0, peers: 0, elapsed_ms: 0 }));
        case 'http://node-1/acquire':
          return Promise.resolve(new Response(body, { headers: { 'content-length': String(good.length) } }));
        case `http://node-1/torrent/${infoHash}`:
          return Promise.resolve(new Response(info));
        default:
          return Promise.resolve(Response.json('Charged'));
      }
    }) as typeof fetch;
    const cache = new CacheNodes({
      providersUrl: 'http://set/providers',
      payerSeed: testPayerSeed('dotli'),
      fetch: fakeFetch,
    });
    const magnet = `magnet:?xt=urn:btih:${infoHash}&so=1`;

    // When the host reads the magnet link while the bytes come, and again after they came
    const first = await cache.readTorrent(magnet);
    rest();
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = await cache.readTorrent(magnet);

    // Then the first answer is the progress of the transfer, and the second one is the checked file, from one read
    expect({
      first: first.progress && {
        state: first.progress.state,
        downloaded: first.progress.downloaded,
        size: first.progress.size,
      },
      firstValue: first.value,
      second: second.value?.length,
      served: second.served?.provider.api,
      reads: requests.filter(url => url.endsWith('/acquire')).length,
    }).toEqual({
      first: { state: 'receiving', downloaded: 65_536, size: good.length },
      firstValue: undefined,
      second: 300_007,
      served: 'http://node-1',
      reads: 1,
    });
  });
});

describe('retention on cache nodes', () => {
  it('As a user agent, I calculate the price of retention as the ledger does: each started MiB and hour', () => {
    expect([
      retentionPrice(165, 3600, 1),
      retentionPrice(165, 3601, 1),
      retentionPrice(5 * 1024 * 1024, 3600, 1),
      retentionPrice(5 * 1024 * 1024 + 1, 7 * 24 * 3600, 2),
    ]).toEqual([1, 2, 5, 2016]);
  });

  it('As a user agent, I calculate the prices of a ledger that counts MiB-days and prices reads by the MiB', () => {
    // Given a ledger with 3 credits for each MiB-day and 2 credits for each MiB of a read, and an older ledger
    const byDay = { readPrice: 10, readPricePerMib: 2, retentionPrice: 3, retentionUnitSecs: 86_400 };
    const byHour = { readPrice: 10, readPricePerMib: 0, retentionPrice: 1, retentionUnitSecs: 3600 };

    // When the host prices retention, one day of a lease and reads
    const prices = {
      week: retentionPrice(5 * 1024 * 1024 + 1, 7 * 86_400, byDay.retentionPrice, byDay.retentionUnitSecs),
      hour: retentionPrice(165, 3600, byDay.retentionPrice, byDay.retentionUnitSecs),
      days: [leaseDayPrice(165, byDay), leaseDayPrice(3 * 1024 * 1024, byHour)],
      reads: [readPrice(0, byDay), readPrice(2 * 1024 * 1024 + 1, byDay), readPrice(50 * 1024 * 1024, byHour)],
    };

    // Then a started day and a started MiB count whole, and a ledger without a price by the MiB has one read price
    expect(prices).toEqual({ week: 126, hour: 3, days: [3, 72], reads: [2, 6, 10] });
  });

  it('As a user agent, I give a product a reason that it can act on when a node does not keep content', () => {
    const errors = [
      pinError(402, 'refused: payer ab has 0 credits'),
      pinError(404, 'not found'),
      pinError(400, "rejected: a pin ends 1 to 1209600 seconds after the node's clock 5, not at 9999999"),
      pinError(500, 'boom'),
    ];
    expect(errors.map(error => [error.kind, error.maxSecs])).toEqual([
      ['not-available', undefined],
      ['not-found', undefined],
      ['period-too-long', 1209600],
      ['failed', undefined],
    ]);
  });

  it('As a user agent, I pay a home node of the content in advance to keep it, with an authorization for the size and the window', async () => {
    // Given three nodes, and a chunked file of 2.5 MiB whose manifest is CID
    const nodes = [provider(1), provider(2), provider(3), provider(4)];
    const pins: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'http://set/providers') {
        return Promise.resolve(Response.json(nodes));
      }
      pins.push({ url, body: JSON.parse(init?.body as string) as Record<string, unknown> });
      return Promise.resolve(
        Response.json({
          node: 'A',
          id: CID,
          size: 2_621_440,
          origin: 'source',
          failed_peers: [],
          until: 9,
          charged: 3,
          chunks: 3,
        }),
      );
    }) as typeof fetch;
    const cache = new CacheNodes({
      providersUrl: 'http://set/providers',
      payerSeed: testPayerSeed('dotli'),
      fetch: fakeFetch,
      storage: null,
    });

    // When the host picks the node and keeps the file for an hour
    const chosen = await cache.retentionProvider(CID);
    const kept = await cache.retain(chosen, CID, 2_621_440, 3600);

    // Then the node is a home node of the content, the pin goes to it, and the payer signed the size and the window
    const pin = pins[0];
    const authorization = pin?.body['authorization'] as { receipt: Record<string, unknown>; signature: string };
    const receipt = authorization.receipt;
    const message = retentionMessage({
      transfer: String(receipt['transfer']),
      payer: cache.payer.id,
      provider: chosen.id,
      content: CID,
      size: 2_621_440,
      from: Number(receipt['from']),
      until: Number(receipt['until']),
    });
    expect({
      home: homeNodes(
        CID,
        nodes.map(node => node.id),
      ).includes(chosen.id),
      url: pin?.url,
      reference: pin?.body['reference'],
      service: receipt['service'],
      size: receipt['size'],
      window: Number(receipt['until']) - Number(receipt['from']),
      signed: verify(message, fromHex(authorization.signature), fromHex(cache.payer.id)),
      kept: { ...kept, provider: kept.provider.api },
    }).toEqual({
      home: true,
      url: `${chosen.api}/pin`,
      reference: { source: `bulletin:${CID}`, cid: null, size: 2_621_440 },
      service: 'Retention',
      size: 2_621_440,
      window: 3600,
      signed: true,
      kept: { provider: chosen.api, until: 9, size: 2_621_440, chunks: 3, charged: 3, state: 'kept' },
    });
  });

  it('As a user agent, I sign a lease that renews until I stop it, with the price of one day as its limit, and later stop it', async () => {
    // Given a node whose ledger charges 2 credits for each MiB-day, and that keeps the content until the end of day 0
    const node = provider(5);
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const cache = new CacheNodes({
      providersUrl: 'http://set/providers',
      payerSeed: testPayerSeed('dotli'),
      storage: null,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === 'http://set/providers') {
          return Promise.resolve(Response.json([node]));
        }
        if (url.includes('/account/')) {
          return Promise.resolve(
            Response.json({ balance: 100, paid: 100, price: 10, retention_price: 2, retention_unit_secs: 86_400 }),
          );
        }
        posts.push({ url, body: JSON.parse(init?.body as string) as Record<string, unknown> });
        if (url.endsWith('/leases/stop')) {
          return Promise.resolve(Response.json({ stopped: 1 }));
        }
        return Promise.resolve(Response.json({ until: 86_400, size: 3 << 20, chunks: 0, charged: 6 }));
      },
    });

    // When the host keeps 3 MiB with a lease without an end, then stops the lease
    const kept = await cache.retain(node, CID, 3 << 20, 0, { renew: true });
    const stopped = await cache.stop(CID, node);

    // Then the pin has a lease authorization that the payer signed, for at most 6 credits a day, and no end
    const pin = posts.find(post => post.url.endsWith('/pin'));
    const authorization = pin?.body['authorization'] as { receipt: Record<string, unknown>; signature: string };
    const receipt = authorization.receipt;
    const lease = leaseMessage({
      transfer: String(receipt['transfer']),
      payer: cache.payer.id,
      provider: node.id,
      content: CID,
      size: 3 << 20,
      from: Number(receipt['from']),
      until: 0,
      maxPerDay: 6,
    });
    // And the stop request names the payer, the node and the content, with the signature of the payer
    const stop = posts.find(post => post.url.endsWith('/leases/stop'))?.body as {
      request: { payer: string; provider: string; content: string; issued_at: number };
      signature: string;
    };
    const stopBytes = stopMessage({ ...stop.request, issuedAt: stop.request.issued_at });
    expect({
      service: receipt['service'],
      until: receipt['until'],
      maxPerDay: receipt['max_per_day'],
      signed: verify(lease, fromHex(authorization.signature), fromHex(cache.payer.id)),
      kept: { until: kept.until, charged: kept.charged, lease: kept.lease },
      stop: [stop.request.provider, stop.request.content, stopped],
      stopSigned: verify(stopBytes, fromHex(stop.signature), fromHex(cache.payer.id)),
    }).toEqual({
      service: 'Lease',
      until: 0,
      maxPerDay: 6,
      signed: true,
      kept: { until: 86_400, charged: 6, lease: true },
      stop: [node.id, CID, 1],
      stopSigned: true,
    });
  });
});

// The root block of the site cache-demo.paseo on Paseo Bulletin Next: the dag-pb file node (sha2-256) that bulletin-deploy
// wrote over the three raw chunks of the site's CAR. The cache (src/bulletin.rs) and ctest (vectors/site-root.json) have
// it too.
const SITE_ROOT = fromHex(
  '122b0a2401551220790e8fe960819b22c3e0aa271bf9f60b060e6ac93aa627cde27885ea897f92a5120018a50c122c0a2401551220b2e01a32e5ca22d806c76069e53d8986f3767e513de1e4d501b7bb47cfb4f342120018d4fa0e122b0a240155122018658392ed83c55d5e0e31e3c8c3eb2bbbde991e6064fefac153f93061652b221200188e070a10080218878e0f20a50c20d4fa0e208e07',
);
const SITE = 'bafybeicepvbzj6i4yflvozwz464yxasywzpf6uvabuz5ol2bs3johuoxxe';
const SITE_TWIN = 'bafkreicepvbzj6i4yflvozwz464yxasywzpf6uvabuz5ol2bs3johuoxxe';

describe('sites on cache nodes', () => {
  it('As a user agent, I ask for a block of a site by its raw twin, and I learn the size of a site from its root block', () => {
    expect([rawTwin(SITE), rawTwin(SITE_TWIN), dagSize(SITE_ROOT), dagSize(new Uint8Array([1, 2, 3]))]).toEqual([
      SITE_TWIN,
      SITE_TWIN,
      { size: 247_713, links: 3 },
      null,
    ]);
  });

  it('As a user agent that loads a site, I take a block from a node only when it matches the CID, and I pay for it', async () => {
    // Given a node that has the root block, and a node that sends other bytes
    const requests: { url: string; body: string }[] = [];
    const nodes = [
      { id: '01'.repeat(32), api: 'http://liar' },
      { id: '02'.repeat(32), api: 'http://good' },
    ];
    const cache = new CacheNodes({
      providersUrl: 'http://set/providers',
      payerSeed: testPayerSeed('dotli'),
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requests.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
        if (url === 'http://set/providers') {
          return Promise.resolve(Response.json(nodes));
        }
        if (url.endsWith('/acquire')) {
          return Promise.resolve(
            new Response(url.startsWith('http://good') ? SITE_ROOT.slice().buffer : new Uint8Array([9, 9]).buffer, {
              status: 200,
            }),
          );
        }
        return Promise.resolve(Response.json({}));
      },
    });

    // When the host reads the root block of the site
    const read = await cache.readBlock(SITE);
    await new Promise(resolve => setTimeout(resolve, 0));

    // Then the good node served the block by its raw twin, the liar got nothing, and only the good node got a receipt
    const asked = requests
      .filter(r => r.url.endsWith('/acquire'))
      .map(r => JSON.parse(r.body) as { reference: { source: string } });
    expect({
      value: read.value?.length,
      outcomes: read.attempts.map(a => [a.provider.api, a.outcome]).sort(),
      sources: [...new Set(asked.map(a => a.reference.source))],
      receipts: requests.filter(r => r.url.endsWith('/receipt')).map(r => r.url),
    }).toEqual({
      value: 154,
      outcomes: [
        ['http://good', 'served'],
        ['http://liar', 'bad-bytes'],
      ].filter(([api]) => read.attempts.some(a => a.provider.api === api)),
      sources: [`bulletin:${SITE_TWIN}`],
      receipts: ['http://good/receipt'],
    });
  });

  it('As a user agent, I keep a site in the background: the node answers at once, and I follow its progress to the end', async () => {
    // Given a node that fetches in the background, and is done at the second look
    const node = { id: '03'.repeat(32), api: 'http://node' };
    let looks = 0;
    const cache = new CacheNodes({
      providersUrl: 'http://set/providers',
      payerSeed: testPayerSeed('dotli'),
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === 'http://set/providers') {
          return Promise.resolve(Response.json([node]));
        }
        if (url === 'http://node/pin') {
          const body = JSON.parse(init?.body as string) as { background?: boolean };
          expect(body.background).toBe(true);
          return Promise.resolve(Response.json({ pin_id: 'p-1', state: 'fetching' }, { status: 202 }));
        }
        looks += 1;
        return Promise.resolve(
          Response.json(
            looks < 2
              ? { pin_id: 'p-1', state: 'fetching', pieces: 1, total_pieces: 4, bytes: 154, total_bytes: 247_713 }
              : {
                  pin_id: 'p-1',
                  state: 'kept',
                  pieces: 4,
                  total_pieces: 4,
                  bytes: 247_713,
                  total_bytes: 247_713,
                  pin: { until: 99, size: 247_713, chunks: 3, charged: 1 },
                },
          ),
        );
      },
    });

    // When the host keeps the site with a wait long enough for two looks
    const kept = await cache.retain(node, SITE, 247_713, 3600, { background: true, waitMs: 5_000 });

    // Then the answer is the pin of the node, after its progress
    expect({ ...kept, provider: kept.provider.api, looks }).toEqual({
      provider: 'http://node',
      until: 99,
      size: 247_713,
      chunks: 3,
      charged: 1,
      state: 'kept',
      looks: 2,
    });
  });
});

describe('the retentions of a payer', () => {
  it('As a user agent, I sign the same request for my retentions as the cache and the CLI host', () => {
    const payer = payerFromSeed(new Uint8Array(32).fill(1));
    expect(toHex(leasesMessage(payer.id, 1_790_000_000))).toBe(
      '63616368652d6c65617365732f31189dac29296d31814dc8c56cf3d36a0543372bba7538fa322a4aebfebc39e056803bb16a00000000',
    );
  });

  it('As a person, I see each retention with what its node holds now', async () => {
    // Given a ledger with four retentions: kept on A, fetching on A, lost on B, and on a node not in the set
    const a = { id: '0a'.repeat(32), api: 'http://a', name: 'A', region: 'Paris' };
    const b = { id: '0b'.repeat(32), api: 'http://b' };
    const now = Math.floor(Date.now() / 1000);
    const lease = (content: string, provider: string, until: number) => ({
      content,
      provider,
      from: 1,
      until,
      size: 10,
      charged: 2,
    });
    const renewing = { ...lease('daily', a.id, now + 50), paid_until: now + 50, per_day: 3, renews: true };
    let signed: { request: { payer: string; issued_at: number }; signature: string } | undefined;
    const cache = new CacheNodes({
      providersUrl: 'http://set/providers',
      payerSeed: testPayerSeed('dotli'),
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === 'http://set/providers') {
          return Promise.resolve(Response.json([a, b]));
        }
        if (url.endsWith('/leases')) {
          signed = JSON.parse(init?.body as string) as typeof signed;
          return Promise.resolve(
            Response.json({
              payer: signed?.request.payer,
              leases: [
                lease('kept', a.id, now + 99),
                lease('fetching', a.id, now + 99),
                lease('gone', b.id, now + 99),
                lease('far', '0c'.repeat(32), now + 99),
                renewing,
              ],
            }),
          );
        }
        const content = url.split('/').pop();
        const states: Record<string, object> = {
          kept: { state: 'kept', blocks: 4 },
          fetching: { state: 'fetching', blocks: 0, pieces: 1, total_pieces: 4 },
          gone: { state: 'none', blocks: 0 },
          daily: { state: 'kept', blocks: 1 },
        };
        return Promise.resolve(Response.json(states[content ?? ''] ?? {}));
      },
    });

    // When the host asks for the retentions of its payer
    const answer = await cache.retentions();

    // Then the request is signed by the payer, and each retention has the state of its node
    expect(
      signed &&
        verify(
          leasesMessage(signed.request.payer, signed.request.issued_at),
          fromHex(signed.signature),
          fromHex(signed.request.payer),
        ),
    ).toBe(true);
    expect(answer.leases.map(item => [item.content, item.state, item.pieces, item.total])).toEqual([
      ['kept', 'kept', 4, 4],
      ['fetching', 'fetching', 1, 4],
      ['gone', 'lost', 1, 1],
      ['far', 'unknown', 1, 1],
      ['daily', 'kept', 1, 1],
    ]);
    // And a retention paid in advance is paid to its end, and a lease that renews has its paid days and its day price
    expect(answer.leases.map(item => [item.content, item.paidUntil - now, item.perDay, item.renews])).toEqual([
      ['kept', 99, 0, false],
      ['fetching', 99, 0, false],
      ['gone', 99, 0, false],
      ['far', 99, 0, false],
      ['daily', 50, 3, true],
    ]);
    // And node B, which lost paid content, counts a failure, so the order of the host puts it after A
    const order = await cache.choices();
    expect(order.map(choice => [choice.provider.id, choice.failedRecently])).toEqual([
      [a.id, false],
      [b.id, true],
    ]);
  });
});

describe('a new payer', () => {
  it('As a new payer on a test network, my user agent enrolls me once, and I get the daily allowance', async () => {
    // Given a ledger that does not know the payer, and enrolls payers
    let enrolled = false;
    let signed: { request: { payer: string; issued_at: number }; signature: string } | undefined;
    const node = { id: '0d'.repeat(32), api: 'http://node' };
    const cache = new CacheNodes({
      providersUrl: 'http://set/providers',
      payerSeed: new Uint8Array(32).fill(9),
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === 'http://set/providers') {
          return Promise.resolve(Response.json([node]));
        }
        const quote = (known: boolean) => ({
          balance: known ? 500 : 0,
          allowance: known ? 500 : 0,
          paid: 0,
          price: 10,
          retention_price: 1,
          allowance_per_day: 500,
          known,
        });
        if (url.endsWith('/enroll')) {
          signed = JSON.parse(init?.body as string) as typeof signed;
          enrolled = true;
          return Promise.resolve(Response.json(quote(true)));
        }
        return Promise.resolve(Response.json(quote(enrolled)));
      },
    });

    // When the user agent asks for the account
    const account = await cache.account();

    // Then it enrolled the payer with a request that the payer signed, and the account has the allowance
    expect(
      signed &&
        verify(
          enrollMessage(signed.request.payer, signed.request.issued_at),
          fromHex(signed.signature),
          fromHex(signed.request.payer),
        ),
    ).toBe(true);
    expect([account.allowance, toHex(enrollMessage(SEVENS, 1)).slice(0, 28)]).toEqual([
      500,
      toHex(new TextEncoder().encode('cache-enroll/1')),
    ]);
  });
});
