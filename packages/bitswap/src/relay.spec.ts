// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import type { SandboxChannel, SandboxMessageOf, SandboxMessageType, SandboxSender } from '@dotli/sandbox-wire';
import {
  createSandboxBlockRelay,
  type BlockCache,
  type BlockOrigin,
  type ContentProgress,
  type SandboxBlockRelayDeps,
} from './relay.js';

const SANDBOX_ORIGIN = 'https://a.app.dot.li';
const BLOCK = new Uint8Array([0xab, 0xcd]);

type AnyHandler = (message: never, sender: SandboxSender) => void;

/** The host's sandbox channel as the relay sees it: typed messages that already passed the origin rule. */
function fakeChannel(): {
  channel: SandboxChannel;
  /** Delivers `message` from `source`, at the sandbox origin unless the test names another. */
  send: <T extends SandboxMessageType>(source: unknown, message: SandboxMessageOf<T>, origin?: string) => void;
  listeners: () => number;
} {
  const handlers = new Map<SandboxMessageType, Set<AnyHandler>>();
  return {
    channel: {
      on(type, handler) {
        const forType = handlers.get(type) ?? new Set<AnyHandler>();
        handlers.set(type, forType);
        forType.add(handler);
        return () => {
          forType.delete(handler);
        };
      },
    },
    send(source, message, origin = SANDBOX_ORIGIN) {
      for (const handler of handlers.get(message.type) ?? []) {
        (handler as (message: unknown, sender: SandboxSender) => void)(message, {
          origin,
          source: source as MessageEventSource,
        });
      }
    },
    listeners: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

interface Reply {
  type: string;
  id: string;
  ok: boolean;
  bytes?: Uint8Array;
  errorName?: string;
  code?: number;
}

/** A sandbox frame that receives replies as `postMessage` delivers them: cloned, transferred buffers detached. */
function fakeFrame(): {
  replies: Reply[];
  origins: string[];
  postMessage: (message: unknown, options?: WindowPostMessageOptions) => void;
} {
  const replies = recording<Reply>();
  const origins: string[] = [];
  return {
    replies,
    origins,
    postMessage: (message, options) => {
      origins.push(options?.targetOrigin ?? '');
      replies.push(structuredClone(message, { transfer: options?.transfer ?? [] }) as Reply);
    },
  };
}

interface Fetch {
  cid: string;
  signal: AbortSignal;
}

/** The network: answers each block with `answer`, or holds it until its signal aborts. */
function fakeNetwork(answer: (cid: string) => Uint8Array | Error | 'hold' = () => BLOCK.slice()): {
  fetches: Fetch[];
  blocks: SandboxBlockRelayDeps['blocks'];
} {
  const fetches = recording<Fetch>();
  return {
    fetches,
    blocks: (cid, signal) => {
      fetches.push({ cid, signal });
      const reply = answer(cid);
      if (reply === 'hold') {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      }
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  };
}

interface MemoryCache extends BlockCache {
  blocks: Map<string, Uint8Array>;
  deleted: string[];
  writes: number;
}

function memoryCache(
  initial: [string, Uint8Array][] = [],
  fail: { get?: Error; put?: Error; delete?: Error } = {},
): MemoryCache {
  const blocks = new Map(initial);
  const cache: MemoryCache = {
    blocks,
    deleted: [],
    writes: 0,
    // A copy, since the relay transfers the returned buffer and would detach this map's own.
    get: cid => (fail.get ? Promise.reject(fail.get) : Promise.resolve(blocks.get(cid)?.slice() ?? null)),
    put: (cid, bytes) => {
      cache.writes += 1;
      if (fail.put) {
        return Promise.reject(fail.put);
      }
      blocks.set(cid, bytes);
      return Promise.resolve();
    },
    delete: cid => {
      cache.deleted.push(cid);
      if (fail.delete) {
        return Promise.reject(fail.delete);
      }
      blocks.delete(cid);
      return Promise.resolve();
    },
  };
  return cache;
}

/** Bytes match only the block they were made for, as a hash would. */
const matchesBlock: SandboxBlockRelayDeps['verify'] = (_cid, bytes) =>
  Promise.resolve(bytes.length === BLOCK.length && bytes.every((byte, i) => byte === BLOCK[i]));

function get(id: string, cid = 'bafyBlock'): SandboxMessageOf<'dotli:bitswap-get'> {
  return { type: 'dotli:bitswap-get', id, cid };
}

function abort(...ids: string[]): SandboxMessageOf<'dotli:bitswap-abort'> {
  return { type: 'dotli:bitswap-abort', ids };
}

const pushed = new WeakMap<unknown[], Set<() => void>>();

/** An empty list whose pushes wake {@link until}, so a test waits on the entry arriving rather than polling. */
function recording<T>(): T[] {
  const items: T[] = [];
  const push = items.push.bind(items);
  // Not enumerable, so the list still equals a plain array.
  Object.defineProperty(items, 'push', {
    value: (...added: T[]): number => {
      const length = push(...added);
      for (const wake of [...(pushed.get(items) ?? [])]) {
        wake();
      }
      return length;
    },
  });
  return items;
}

/** Resolves once `items`, made by {@link recording}, holds `count` entries, and checks it holds no more. */
async function until(items: unknown[], count = 1): Promise<void> {
  await new Promise<void>(resolve => {
    const wakers = pushed.get(items) ?? new Set();
    pushed.set(items, wakers);
    const wake = (): void => {
      if (items.length >= count) {
        wakers.delete(wake);
        resolve();
      }
    };
    wakers.add(wake);
    wake();
  });
  expect(items).toHaveLength(count);
}

describe('createSandboxBlockRelay', () => {
  it('As a sandbox, I get the block I asked for on my own origin, its buffer handed over', async () => {
    // Given
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({ channel, blocks: fakeNetwork().blocks, cache: null, verify: matchesBlock });
    const frame = fakeFrame();

    // When
    send(frame, get('req-1'));
    await until(frame.replies);

    // Then
    expect(frame.replies).toEqual([{ type: 'dotli:bitswap-result', id: 'req-1', ok: true, bytes: BLOCK }]);
    expect(frame.origins).toEqual([SANDBOX_ORIGIN]);
  });

  it('As an operator, I see a failed fetch reach the sandbox with its error class and code', async () => {
    // Given
    const failure = Object.assign(new Error('bitswap_v1_get failed (code=-32602): invalid'), {
      name: 'BitswapRpcError',
      code: -32602,
    });
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({ channel, blocks: fakeNetwork(() => failure).blocks, cache: null, verify: matchesBlock });
    const frame = fakeFrame();

    // When
    send(frame, get('req-1'));
    await until(frame.replies);

    // Then
    expect(frame.replies).toEqual([
      {
        type: 'dotli:bitswap-result',
        id: 'req-1',
        ok: false,
        error: expect.stringContaining('invalid') as unknown,
        errorName: 'BitswapRpcError',
        code: -32602,
      },
    ]);
  });

  it('As a user, I leave a page and the fetches that page asked for stop', async () => {
    // Given
    const network = fakeNetwork(() => 'hold');
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: matchesBlock });
    const frame = fakeFrame();
    send(frame, get('req-1'));
    await until(network.fetches);

    // When
    send(frame, abort('req-1'));

    // Then
    expect(network.fetches.map(fetch => fetch.signal.aborted)).toEqual([true]);
  });

  it("As a user, I close one product and another product's fetches carry on", async () => {
    // Given two frames at sandbox origins, and a fetch belonging to the first
    const network = fakeNetwork(() => 'hold');
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: matchesBlock });
    const victim = fakeFrame();
    const attacker = fakeFrame();
    send(victim, get('req-1'));
    await until(network.fetches);

    // When the other frame guesses the id
    send(attacker, abort('req-1'));

    // Then
    expect(network.fetches.map(fetch => fetch.signal.aborted)).toEqual([false]);
  });

  it('As a user, I navigate a product frame mid-download and its fetches stop, though the host reads the abort after the frame is gone', async () => {
    // Given a fetch the frame tagged with its own id
    const network = fakeNetwork(() => 'hold');
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: matchesBlock });
    const frame = fakeFrame();
    send(frame, { ...get('req-1'), frame: 'frame-a' });
    await until(network.fetches);

    // When its abort arrives with no source, as one posted on `pagehide` does
    send(null, { ...abort('req-1'), frame: 'frame-a' });

    // Then the fetch the frame asked for stopped
    expect(network.fetches.map(fetch => fetch.signal.aborted)).toEqual([true]);
  });

  it("As a user, another frame that names a different frame id cannot stop my product's fetches", async () => {
    // Given a fetch my product's frame tagged with its own id
    const network = fakeNetwork(() => 'hold');
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: matchesBlock });
    const frame = fakeFrame();
    send(frame, { ...get('req-1'), frame: 'frame-a' });
    await until(network.fetches);

    // When another frame aborts the same id under its own frame id, and a frame with no id aborts it too
    send(null, { ...abort('req-1'), frame: 'frame-b' });
    send(fakeFrame(), abort('req-1'));

    // Then my product's fetch carries on
    expect(network.fetches.map(fetch => fetch.signal.aborted)).toEqual([false]);
  });

  it("As a user, a sandbox on another product's origin that names my frame id cannot stop my product's fetches", async () => {
    // Given a fetch my product's frame tagged with its own id
    const network = fakeNetwork(() => 'hold');
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: matchesBlock });
    send(fakeFrame(), { ...get('req-1'), frame: 'frame-a' });
    await until(network.fetches);

    // When another product's sandbox sends an abort for the same frame id and request id
    send(null, { ...abort('req-1'), frame: 'frame-a' }, 'https://b.app.dot.li');

    // Then my product's fetch carries on
    expect(network.fetches.map(fetch => fetch.signal.aborted)).toEqual([false]);
  });

  it("As a user, I load two frames at once and neither strands the other's fetches", async () => {
    // Given two frames whose ids collide, the first served at once and the second held
    const network = fakeNetwork(cid => (cid === 'bafyFast' ? BLOCK.slice() : 'hold'));
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: matchesBlock });
    const first = fakeFrame();
    const second = fakeFrame();
    send(first, get('req-1', 'bafyFast'));
    send(second, get('req-1', 'bafySlow'));
    await until(network.fetches, 2);
    await until(first.replies);

    // When the second frame cancels, after the first has settled
    send(second, abort('req-1'));

    // Then its fetch stopped, rather than being orphaned by the first fetch's cleanup
    expect(first.replies).toHaveLength(1);
    expect(network.fetches.find(fetch => fetch.cid === 'bafySlow')?.signal.aborted).toBe(true);
  });

  it('As the host, I stop the relay and it stops listening to the channel', () => {
    // Given
    const { channel, listeners } = fakeChannel();
    const relay = createSandboxBlockRelay({ channel, blocks: fakeNetwork().blocks, cache: null, verify: matchesBlock });

    // When
    relay.stop();

    // Then
    expect(listeners()).toBe(0);
  });
});

describe('createSandboxBlockRelay with a block cache', () => {
  it('As a user, I open an app I opened before and its blocks load without the network', async () => {
    // Given a relay with a cache, and one load that fetched the block
    const network = fakeNetwork();
    const { channel, send } = fakeChannel();
    const relay = createSandboxBlockRelay({
      channel,
      blocks: network.blocks,
      cache: memoryCache(),
      verify: matchesBlock,
    });
    const served: string[] = [];
    relay.onServed(from => served.push(from));
    const firstLoad = fakeFrame();
    send(firstLoad, get('req-1'));
    await until(firstLoad.replies);

    // When the app loads again
    const secondLoad = fakeFrame();
    send(secondLoad, get('req-1'));
    await until(secondLoad.replies);

    // Then the block came from the cache, whole, although the first reply transferred its buffer away
    expect(network.fetches).toHaveLength(1);
    expect(secondLoad.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(served).toEqual(['network', 'cache']);
  });

  it('As a user, I get a cached block that no longer matches its CID fetched again, not served', async () => {
    // Given a cache holding corrupted bytes for the block
    const network = fakeNetwork();
    const cache = memoryCache([['bafyBlock', new Uint8Array([0x00])]]);
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache, verify: matchesBlock });

    // When
    const frame = fakeFrame();
    send(frame, get('req-1'));
    await until(frame.replies);

    // Then
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(network.fetches).toHaveLength(1);
    expect(cache.deleted).toEqual(['bafyBlock']);
    expect(cache.blocks.get('bafyBlock')).toEqual(BLOCK);
  });

  it('As a sandbox asking for a block a peer forged, I get a verification failure and the block is not served', async () => {
    // Given a network that hands back bytes of some other block
    const captured = recordCaptures({ onFinished: onTestFinished });
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const cache = memoryCache();
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: fakeNetwork(() => new Uint8Array([0x01, 0x02])).blocks,
      cache,
      verify: matchesBlock,
    });

    // When
    const frame = fakeFrame();
    send(frame, get('req-1'));
    await until(frame.replies);

    // Then the sandbox gets a failure named for verification, nothing is kept, and the mismatch is counted
    expect(frame.replies).toEqual([
      {
        type: 'dotli:bitswap-result',
        id: 'req-1',
        ok: false,
        error: expect.stringContaining('bafyBlock') as unknown,
        errorName: 'ContentVerificationError',
      },
    ]);
    expect(cache.writes).toBe(0);
    expect(captured).toEqual([{ flow: 'content', step: 'relay_verify', tags: { cid: 'bafyBlock' } }]);
    expect(sentry.counted('content.block_relay')).toEqual([{ outcome: 'error', reason: 'mismatch', step: 'verify' }]);
  });

  it('As a sandbox with the archive cache off, I get a verification failure for a forged block too', async () => {
    // Given
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: fakeNetwork(() => new Uint8Array([0x01, 0x02])).blocks,
      cache: null,
      verify: matchesBlock,
    });

    // When
    const frame = fakeFrame();
    send(frame, get('req-1'));
    await until(frame.replies);

    // Then
    expect(frame.replies[0]).toMatchObject({ ok: false, errorName: 'ContentVerificationError' });
  });

  it('As a user, I still load the app when the block cache cannot be read', async () => {
    // Given a cache whose reads fail
    const captured = recordCaptures({ onFinished: onTestFinished });
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const network = fakeNetwork();
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: network.blocks,
      cache: memoryCache([], { get: new Error('QuotaExceededError') }),
      verify: matchesBlock,
    });

    // When
    const frame = fakeFrame();
    send(frame, get('req-1'));
    await until(frame.replies);

    // Then the block came from the network, and the failed read was reported
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(network.fetches).toHaveLength(1);
    expect(captured).toEqual([{ flow: 'content', step: 'relay_cache_read', tags: undefined }]);
    expect(sentry.counted('content.block_relay')).toEqual([{ outcome: 'error', reason: 'Error', step: 'cache_read' }]);
  });

  it('As a user with the archive cache off, I get every block from the network', async () => {
    // Given
    const network = fakeNetwork();
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: matchesBlock });

    // When the same block is asked for twice
    const first = fakeFrame();
    send(first, get('req-1'));
    await until(first.replies);
    const second = fakeFrame();
    send(second, get('req-1'));
    await until(second.replies);

    // Then
    expect(network.fetches).toHaveLength(2);
  });

  it('As a user, I get no block when the verifier fails to load, the cached copy is kept for a later check, and nothing is written', async () => {
    // Given a cache already holding the block, but a verifier whose chunk cannot load
    const captured = recordCaptures({ onFinished: onTestFinished });
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const network = fakeNetwork();
    const cache = memoryCache([['bafyBlock', BLOCK.slice()]]);
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: network.blocks,
      cache,
      verify: () => Promise.reject(new Error('verify chunk failed to load')),
    });

    // When
    const frame = fakeFrame();
    send(frame, get('req-1'));
    await until(frame.replies);

    // Then the cached copy was neither trusted nor dropped, the fetched copy could not be checked either, so the
    // sandbox gets a verification failure and nothing was written
    expect(network.fetches).toHaveLength(1);
    expect(frame.replies[0]).toMatchObject({ ok: false, errorName: 'ContentVerificationError' });
    expect(cache.writes).toBe(0);
    expect(cache.deleted).toEqual([]);
    expect(cache.blocks.get('bafyBlock')).toEqual(BLOCK);
    // The verifier failed twice, on the cached copy and on the fetched one, and reports its own load miss
    const verifyFailure = { outcome: 'error', reason: 'Error', step: 'verify' };
    expect(captured).toEqual([]);
    expect(sentry.counted('content.block_relay')).toEqual([verifyFailure, verifyFailure]);
  });

  it('As an operator with the archive cache off, I watch a verifier that cannot load refuse each block, and each is counted but not captured again', async () => {
    // Given a verifier whose chunk cannot load, which reports that miss itself
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const missing = new Error('verify chunk failed to load');
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: fakeNetwork().blocks,
      cache: null,
      verify: () => Promise.reject(missing),
    });

    // When two blocks are asked for
    const frame = fakeFrame();
    send(frame, get('req-1'));
    send(frame, get('req-2'));
    await until(frame.replies, 2);

    // Then both are refused, each miss leaves a breadcrumb and a count, and none is captured
    expect(frame.replies).toMatchObject([
      { ok: false, errorName: 'ContentVerificationError' },
      { ok: false, errorName: 'ContentVerificationError' },
    ]);
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledTimes(2);
    expect(captures.expected).toHaveBeenCalledWith(missing, { flow: 'content', step: 'relay_verify' });
    const verifyFailure = { outcome: 'error', reason: 'Error', step: 'verify' };
    expect(sentry.counted('content.block_relay')).toEqual([verifyFailure, verifyFailure]);
  });

  it('As a user, I ask again once the verifier loads on a later try and my next block is checked and served', async () => {
    // Given a verifier whose first load fails, as during a deploy, and whose next one works
    let checks = 0;
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: fakeNetwork().blocks,
      cache: null,
      verify: (cid, bytes) => {
        checks += 1;
        return checks === 1 ? Promise.reject(new Error('verify chunk failed to load')) : matchesBlock(cid, bytes);
      },
    });

    // When the sandbox asks, is refused, and asks again
    const frame = fakeFrame();
    send(frame, get('req-1'));
    await until(frame.replies);
    send(frame, get('req-2'));
    await until(frame.replies, 2);

    // Then the first is refused and the second is checked and served
    expect(frame.replies).toMatchObject([
      { id: 'req-1', ok: false, errorName: 'ContentVerificationError' },
      { id: 'req-2', ok: true, bytes: BLOCK },
    ]);
  });

  it('As a user, I am still served the fetched block when dropping a corrupted cached block fails', async () => {
    // Given a cache holding corrupted bytes whose delete fails
    const captured = recordCaptures({ onFinished: onTestFinished });
    const reported = recording<true>();
    const sentry = bindRecordingSentry({
      onFinished: onTestFinished,
      onRecord: () => reported.push(true),
    });
    const network = fakeNetwork();
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: network.blocks,
      cache: memoryCache([['bafyBlock', new Uint8Array([0x00])]], { delete: new Error('delete failed') }),
      verify: matchesBlock,
    });

    // When
    const frame = fakeFrame();
    send(frame, get('req-1'));
    await until(frame.replies);
    await until(reported);

    // Then the block came from the network, and the failed delete was reported once
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(network.fetches).toHaveLength(1);
    expect(captured).toEqual([{ flow: 'content', step: 'relay_cache_delete', tags: undefined }]);
    expect(sentry.counted('content.block_relay')).toEqual([
      { outcome: 'error', reason: 'Error', step: 'cache_delete' },
    ]);
  });

  it('As a user, I am still served the fetched block when the block cache write rejects', async () => {
    // Given a cache whose writes fail
    const captured = recordCaptures({ onFinished: onTestFinished });
    const reported = recording<true>();
    const sentry = bindRecordingSentry({
      onFinished: onTestFinished,
      onRecord: () => reported.push(true),
    });
    const { channel, send } = fakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: fakeNetwork().blocks,
      cache: memoryCache([], { put: new Error('write failed') }),
      verify: matchesBlock,
    });

    // When
    const frame = fakeFrame();
    send(frame, get('req-1'));
    await until(frame.replies);

    // Then the block was served, and the failed write was reported once it settled
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    await until(reported);
    expect(captured).toEqual([{ flow: 'content', step: 'relay_cache_write', tags: undefined }]);
    expect(sentry.counted('content.block_relay')).toEqual([{ outcome: 'error', reason: 'Error', step: 'cache_write' }]);
  });
});

describe('createSandboxBlockRelay progress', () => {
  /** A dag-pb root whose two links carry a Tsize of 100 and 50. */
  /** These blocks are sized for the progress count, so they are not any one real block. */
  const acceptsAnyBlock: SandboxBlockRelayDeps['verify'] = () => Promise.resolve(true);
  const ROOT = new Uint8Array([0x12, 0x02, 0x18, 100, 0x12, 0x02, 0x18, 50]);

  it('As a user, I see the loading bar keep moving while the trace listens along', async () => {
    // Given
    const { channel, send } = fakeChannel();
    const relay = createSandboxBlockRelay({
      channel,
      blocks: fakeNetwork(() => new Uint8Array(100)).blocks,
      cache: null,
      verify: acceptsAnyBlock,
    });
    const first = recording<number>();
    const second: number[] = [];
    relay.onProgress(({ bytesFetched }) => first.push(bytesFetched));
    const unsubscribe = relay.onProgress(({ bytesFetched }) => second.push(bytesFetched));

    // When
    send(fakeFrame(), get('req-1'));
    await until(first);
    unsubscribe();
    send(fakeFrame(), get('req-2', 'bafyLeaf'));
    await until(first, 2);

    // Then
    expect(first).toEqual([100, 200]);
    expect(second).toEqual([100]);
  });

  it("As a user, I see the first block's links give the total, and the speed count from that block", async () => {
    // Given a clock that moves 500 ms between the two blocks
    let clock = 1_000;
    const { channel, send } = fakeChannel();
    const relay = createSandboxBlockRelay({
      channel,
      blocks: fakeNetwork(cid => (cid === 'bafyRoot' ? ROOT.slice() : new Uint8Array(100))).blocks,
      cache: null,
      verify: acceptsAnyBlock,
      now: () => clock,
    });
    const progress = recording<ContentProgress>();
    relay.onProgress(update => progress.push(update));

    // When
    send(fakeFrame(), get('req-1', 'bafyRoot'));
    await until(progress);
    clock += 500;
    send(fakeFrame(), get('req-2', 'bafyLeaf'));
    await until(progress, 2);

    // Then
    expect(progress).toEqual([
      { bytesFetched: ROOT.length, totalBytes: 150, bytesPerSecond: 0 },
      { bytesFetched: ROOT.length + 100, totalBytes: 150, bytesPerSecond: ((ROOT.length + 100) / 500) * 1000 },
    ]);
  });

  it('As a user whose load is retried, I watch the bar and it counts from zero again rather than past the total', async () => {
    // Given a relay that served a root and one leaf
    const { channel, send } = fakeChannel();
    const relay = createSandboxBlockRelay({
      channel,
      blocks: fakeNetwork(cid => (cid === 'bafyRoot' ? ROOT.slice() : new Uint8Array(100))).blocks,
      cache: null,
      verify: acceptsAnyBlock,
    });
    const progress = recording<ContentProgress>();
    relay.onProgress(update => progress.push(update));
    send(fakeFrame(), get('req-1', 'bafyRoot'));
    await until(progress);
    send(fakeFrame(), get('req-2', 'bafyLeaf'));
    await until(progress, 2);

    // When the retry walks from the root again
    send(fakeFrame(), get('req-3', 'bafyRoot'));
    await until(progress, 3);

    // Then the third update starts over at the root
    expect(progress.map(({ bytesFetched, totalBytes }) => ({ bytesFetched, totalBytes }))).toEqual([
      { bytesFetched: ROOT.length, totalBytes: 150 },
      { bytesFetched: ROOT.length + 100, totalBytes: 150 },
      { bytesFetched: ROOT.length, totalBytes: 150 },
    ]);
  });

  it('As a user opening a second product, I see its relay count from zero', async () => {
    // Given a first relay that already served a block
    const first = fakeChannel();
    const firstRelay = createSandboxBlockRelay({
      channel: first.channel,
      blocks: fakeNetwork(() => new Uint8Array(100)).blocks,
      cache: null,
      verify: acceptsAnyBlock,
    });
    const firstFrame = fakeFrame();
    first.send(firstFrame, get('req-1'));
    await until(firstFrame.replies);
    firstRelay.stop();

    // When a second relay serves its first block
    const second = fakeChannel();
    const secondRelay = createSandboxBlockRelay({
      channel: second.channel,
      blocks: fakeNetwork(() => new Uint8Array(30)).blocks,
      cache: null,
      verify: acceptsAnyBlock,
    });
    const progress = recording<number>();
    secondRelay.onProgress(({ bytesFetched }) => progress.push(bytesFetched));
    second.send(fakeFrame(), get('req-1'));
    await until(progress);

    // Then
    expect(progress).toEqual([30]);
  });

  it('As a user, I get my block even when a progress or served listener throws, and the other listeners still hear it', async () => {
    // Given a throwing listener ahead of a working one on each of the two feeds
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { channel, send } = fakeChannel();
    const relay = createSandboxBlockRelay({
      channel,
      blocks: fakeNetwork().blocks,
      cache: null,
      verify: acceptsAnyBlock,
    });
    relay.onProgress(() => {
      throw new TypeError('progress broke');
    });
    relay.onServed(() => {
      throw new RangeError('served broke');
    });
    const progress: number[] = [];
    const served: BlockOrigin[] = [];
    relay.onProgress(({ bytesFetched }) => progress.push(bytesFetched));
    relay.onServed(from => served.push(from));
    const frame = fakeFrame();

    // When a block is served
    send(frame, get('req-1'));
    await until(frame.replies);

    // Then the sandbox got the bytes, the working listeners heard it and each throw was counted under its owner
    expect(frame.replies).toEqual([{ type: 'dotli:bitswap-result', id: 'req-1', ok: true, bytes: BLOCK }]);
    expect(progress).toEqual([BLOCK.length]);
    expect(served).toEqual(['network']);
    expect(sentry.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'TypeError', owner: 'bitswap_relay.progress' },
      { outcome: 'error', reason: 'RangeError', owner: 'bitswap_relay.served' },
    ]);
  });
});
