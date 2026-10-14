// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { blake2b } from '@noble/hashes/blake2.js';
import { verify } from '@scure/sr25519';
import { describe, it, expect } from 'vitest';

import {
  CacheNodes,
  orderProviders,
  parseOrigin,
  payerFromSeed,
  readMessage,
  receiptMessage,
  rendezvousScore,
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
      receipt: toHex(receiptMessage(fields)),
    }).toEqual({
      payer: '189dac29296d31814dc8c56cf3d36a0543372bba7538fa322a4aebfebc39e056',
      score: '1b90bef8509cc25b45d94885d8a1eca44bd751212310efc75c9e2628a663b98f',
      read: `63616368652d726561642f31${shared}e01ec86a00000000`,
      receipt: `63616368652d726563656970742f32${shared}${'00'.repeat(25)}`,
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
    const body = receipt?.body as { receipt: { transfer: string }; signature: string };
    const message = receiptMessage({
      transfer: body.receipt.transfer,
      payer: cache.payer.id,
      provider: holder.id,
      content: CID,
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
      older: { paid: atOlder.paid, allowance: atOlder.allowance, readPrice: atOlder.readPrice },
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
        retentionPrice: 1,
      },
      older: { paid: 940, allowance: 0, readPrice: 10 },
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
    }).toEqual({
      value: 300_007,
      same: true,
      name: 'dir/f1.bin',
      contentId: `bt:${infoHash}:1`,
      outcomes: ['http://node-1:bad-bytes', 'http://node-2:served'],
      content: `bt:${infoHash}:1`,
      file: 1,
      receipts: ['http://node-2/receipt'],
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
