// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import type { SandboxChannel, SandboxMessageOf, SandboxMessageType, SandboxSender } from '@dotli/sandbox-wire';
import { createSandboxBlockRelay, type ContentProgress } from './createSandboxBlockRelay.js';
import type { BlockOrigin } from './serveBlock.js';

const SANDBOX_ORIGIN = 'https://a.app.dot.li';
const BLOCK = new Uint8Array([0xab, 0xcd]);

type AnyHandler = (message: never, sender: SandboxSender) => void;

type RelayParams = Parameters<typeof createSandboxBlockRelay>[0];

/** The host's sandbox channel as the relay sees it: typed messages that already passed the origin rule. */
function createFakeChannel() {
  const handlers = new Map<SandboxMessageType, Set<AnyHandler>>();
  const channel: SandboxChannel = {
    on(type, handler) {
      const forType = handlers.get(type) ?? new Set<AnyHandler>();
      handlers.set(type, forType);
      forType.add(handler);
      return () => {
        forType.delete(handler);
      };
    },
  };
  return {
    channel,
    /** Delivers `message` from `source`, at the sandbox origin unless the test names another. */
    send: <T extends SandboxMessageType>(
      source: unknown,
      message: SandboxMessageOf<T>,
      origin = SANDBOX_ORIGIN,
    ): void => {
      for (const handler of handlers.get(message.type) ?? []) {
        // A handler is typed by its own message type, which the map keyed by type cannot carry.
        (handler as (message: unknown, sender: SandboxSender) => void)(message, {
          origin,
          // A fake frame, or null, stands in for the window: the relay only calls `postMessage` on it.
          source: source as MessageEventSource,
        });
      }
    },
    /** How many handlers are still attached. */
    listeners: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

type Reply = {
  type: string;
  id: string;
  ok: boolean;
  bytes?: Uint8Array;
  errorName?: string;
  code?: number;
};

/** A sandbox frame that receives replies as `postMessage` delivers them: cloned, transferred buffers detached. */
function createFakeFrame(): {
  replies: Reply[];
  origins: string[];
  postMessage: (message: unknown, options?: WindowPostMessageOptions) => void;
} {
  const replies = createRecording<Reply>();
  const origins: string[] = [];
  return {
    replies,
    origins,
    postMessage: (message, options) => {
      origins.push(options?.targetOrigin ?? '');
      // The relay posts only `BitswapResultMessage`s, which `Reply` reads a subset of.
      replies.push(structuredClone(message, { transfer: options?.transfer ?? [] }) as Reply);
    },
  };
}

type Fetch = {
  cid: string;
  signal: AbortSignal;
};

/** The network: answers each block with `answer`, or holds it until its signal aborts. */
function createFakeNetwork(answer: (cid: string) => Uint8Array | Error | 'hold' = () => BLOCK.slice()): {
  fetches: Fetch[];
  blocks: RelayParams['blocks'];
} {
  const fetches = createRecording<Fetch>();
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

function createMemoryCache(
  initial: [string, Uint8Array][] = [],
  fail: { get?: Error; put?: Error; delete?: Error } = {},
) {
  const blocks = new Map(initial);
  const deleted: string[] = [];
  let writes = 0;
  return {
    /** What the cache holds now. */
    blocks,
    /** The CIDs asked to be deleted, in order. */
    deleted,
    /** How many writes were attempted, failed ones included. */
    get writes(): number {
      return writes;
    },
    // A copy, since the relay transfers the returned buffer and would detach this map's own.
    get: (cid: string) => (fail.get ? Promise.reject(fail.get) : Promise.resolve(blocks.get(cid)?.slice() ?? null)),
    put: (cid: string, bytes: Uint8Array) => {
      writes += 1;
      if (fail.put) {
        return Promise.reject(fail.put);
      }
      blocks.set(cid, bytes);
      return Promise.resolve();
    },
    delete: (cid: string) => {
      deleted.push(cid);
      if (fail.delete) {
        return Promise.reject(fail.delete);
      }
      blocks.delete(cid);
      return Promise.resolve();
    },
  };
}

/** Bytes match only the block they were made for, as a hash would. */
function verifyBlock(_cid: string, bytes: Uint8Array): Promise<boolean> {
  return Promise.resolve(bytes.length === BLOCK.length && bytes.every((byte, index) => byte === BLOCK[index]));
}

/** A cache whose read of `bafyOld` waits for `release`, and whose other reads miss. */
function createDeferredRead(): { cache: NonNullable<RelayParams['cache']>; release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<Uint8Array | null>(resolve => {
    release = () => {
      resolve(BLOCK.slice());
    };
  });
  return {
    release,
    cache: {
      get: cid => (cid === 'bafyOld' ? held : Promise.resolve(null)),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
  };
}

function createGetRequest(id: string, cid = 'bafyBlock'): SandboxMessageOf<'dotli:bitswap-get'> {
  return { type: 'dotli:bitswap-get', id, cid };
}

function createAbortRequest(...ids: string[]): SandboxMessageOf<'dotli:bitswap-abort'> {
  return { type: 'dotli:bitswap-abort', ids };
}

const pushed = new WeakMap<unknown[], Set<() => void>>();

/** An empty list whose pushes wake {@link waitForLength}, so a test waits on the entry arriving rather than polling. */
function createRecording<T>(): T[] {
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

/** Resolves once `items`, made by {@link createRecording}, holds at least `count` entries. */
async function waitForLength(items: unknown[], count = 1): Promise<void> {
  await new Promise<void>(resolve => {
    const wakers = pushed.get(items) ?? new Set();
    pushed.set(items, wakers);
    function wake(): void {
      if (items.length >= count) {
        wakers.delete(wake);
        resolve();
      }
    }
    wakers.add(wake);
    wake();
  });
}

describe('createSandboxBlockRelay', () => {
  it('As a sandbox, I get the block I asked for on my own origin, its buffer handed over', async () => {
    // Given
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({ channel, blocks: createFakeNetwork().blocks, cache: null, verify: verifyBlock });
    const frame = createFakeFrame();

    // When
    send(frame, createGetRequest('req-1'));
    await waitForLength(frame.replies);

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
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: createFakeNetwork(() => failure).blocks,
      cache: null,
      verify: verifyBlock,
    });
    const frame = createFakeFrame();

    // When
    send(frame, createGetRequest('req-1'));
    await waitForLength(frame.replies);

    // Then
    expect(frame.replies).toEqual([
      {
        type: 'dotli:bitswap-result',
        id: 'req-1',
        ok: false,
        // Vitest types the matcher `any`, widened so no `any` reaches the expected object.
        error: expect.stringContaining('invalid') as unknown,
        errorName: 'BitswapRpcError',
        code: -32602,
      },
    ]);
  });

  it('As an operator, I see a reply that cannot reach its frame reported, and the relay serves the next request', async () => {
    // Given a frame whose first reply throws, as one posted to a window that went away may
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const network = createFakeNetwork();
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: verifyBlock });
    const frame = createFakeFrame();
    const thrown = createRecording<Error>();
    const flakyFrame = {
      postMessage(message: unknown, options?: WindowPostMessageOptions): void {
        if (thrown.length === 0) {
          const error = new Error('frame is gone');
          thrown.push(error);
          throw error;
        }
        frame.postMessage(message, options);
      },
    };

    // When it asks for a block, then for another once the first reply threw
    send(flakyFrame, createGetRequest('req-1'));
    await waitForLength(thrown);
    send(flakyFrame, createGetRequest('req-2'));
    await waitForLength(frame.replies);
    send(flakyFrame, createAbortRequest('req-1'));

    // Then the throw is reported, the second request gets its block, and the first left the table before the throw
    expect(captured).toMatchObject([{ step: 'transition', error: thrown[0] }]);
    expect(sentry.counted('block_relay.transition')).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(frame.replies).toEqual([{ type: 'dotli:bitswap-result', id: 'req-2', ok: true, bytes: BLOCK }]);
    expect(network.fetches.map(fetch => fetch.signal.aborted)).toEqual([false, false]);
  });

  it('As a user, I leave a page and the fetches that page asked for stop', async () => {
    // Given
    const network = createFakeNetwork(() => 'hold');
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: verifyBlock });
    const frame = createFakeFrame();
    send(frame, createGetRequest('req-1'));
    await waitForLength(network.fetches);

    // When
    send(frame, createAbortRequest('req-1'));

    // Then
    expect(network.fetches.map(fetch => fetch.signal.aborted)).toEqual([true]);
  });

  it("As a user, I close one product and another product's fetches carry on", async () => {
    // Given two frames at sandbox origins, and a fetch belonging to the first
    const network = createFakeNetwork(() => 'hold');
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: verifyBlock });
    const victim = createFakeFrame();
    const attacker = createFakeFrame();
    send(victim, createGetRequest('req-1'));
    await waitForLength(network.fetches);

    // When the other frame guesses the id
    send(attacker, createAbortRequest('req-1'));

    // Then
    expect(network.fetches.map(fetch => fetch.signal.aborted)).toEqual([false]);
  });

  it('As a user, I navigate a product frame mid-download and its fetches stop, though the host reads the abort after the frame is gone', async () => {
    // Given a fetch the frame tagged with its own id
    const network = createFakeNetwork(() => 'hold');
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: verifyBlock });
    const frame = createFakeFrame();
    send(frame, { ...createGetRequest('req-1'), frame: 'frame-a' });
    await waitForLength(network.fetches);

    // When its abort arrives with no source, as one posted on `pagehide` does
    send(null, { ...createAbortRequest('req-1'), frame: 'frame-a' });

    // Then the fetch the frame asked for stopped
    expect(network.fetches.map(fetch => fetch.signal.aborted)).toEqual([true]);
  });

  it("As a user, another frame that names a different frame id cannot stop my product's fetches", async () => {
    // Given a fetch my product's frame tagged with its own id
    const network = createFakeNetwork(() => 'hold');
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: verifyBlock });
    const frame = createFakeFrame();
    send(frame, { ...createGetRequest('req-1'), frame: 'frame-a' });
    await waitForLength(network.fetches);

    // When another frame aborts the same id under its own frame id, and a frame with no id aborts it too
    send(null, { ...createAbortRequest('req-1'), frame: 'frame-b' });
    send(createFakeFrame(), createAbortRequest('req-1'));

    // Then my product's fetch carries on
    expect(network.fetches.map(fetch => fetch.signal.aborted)).toEqual([false]);
  });

  it("As a user, a sandbox on another product's origin that names my frame id cannot stop my product's fetches", async () => {
    // Given a fetch my product's frame tagged with its own id
    const network = createFakeNetwork(() => 'hold');
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: verifyBlock });
    send(createFakeFrame(), { ...createGetRequest('req-1'), frame: 'frame-a' });
    await waitForLength(network.fetches);

    // When another product's sandbox sends an abort for the same frame id and request id
    send(null, { ...createAbortRequest('req-1'), frame: 'frame-a' }, 'https://b.app.dot.li');

    // Then my product's fetch carries on
    expect(network.fetches.map(fetch => fetch.signal.aborted)).toEqual([false]);
  });

  it("As a user, I load two frames at once and neither strands the other's fetches", async () => {
    // Given two frames whose ids collide, the first served at once and the second held
    const network = createFakeNetwork(cid => (cid === 'bafyFast' ? BLOCK.slice() : 'hold'));
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: verifyBlock });
    const first = createFakeFrame();
    const second = createFakeFrame();
    send(first, createGetRequest('req-1', 'bafyFast'));
    send(second, createGetRequest('req-1', 'bafySlow'));
    await waitForLength(network.fetches, 2);
    await waitForLength(first.replies);

    // When the second frame cancels, after the first has settled
    send(second, createAbortRequest('req-1'));

    // Then its fetch stopped, rather than being orphaned by the first fetch's cleanup
    expect(network.fetches).toHaveLength(2);
    expect(first.replies).toHaveLength(1);
    expect(network.fetches.find(fetch => fetch.cid === 'bafySlow')?.signal.aborted).toBe(true);
  });

  it('As a user, I ask for a block again under the same id while the first request still runs, and my abort still stops the newer one', async () => {
    // Given a network that answers the first fetch at once and holds the second
    let asked = 0;
    const network = createFakeNetwork(() => {
      asked += 1;
      return asked === 1 ? BLOCK.slice() : 'hold';
    });
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: null, verify: verifyBlock });
    const frame = createFakeFrame();
    send(frame, createGetRequest('req-1'));
    send(frame, createGetRequest('req-1'));
    await waitForLength(frame.replies);

    // When the frame aborts the id after the first request settled
    send(frame, createAbortRequest('req-1'));

    // Then the newer request's fetch stopped
    expect(network.fetches.map(fetch => fetch.signal.aborted)).toEqual([false, true]);
  });

  it("As a user, I reload a product frame while its old request still reads the cache, and my new frame's fetches still stop when it leaves", async () => {
    // Given an old frame whose request was aborted while its cache read is pending, and a new frame reusing its frame id
    const network = createFakeNetwork(() => 'hold');
    const { channel, send } = createFakeChannel();
    const oldRead = createDeferredRead();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache: oldRead.cache, verify: verifyBlock });
    const oldFrame = createFakeFrame();
    send(oldFrame, { ...createGetRequest('req-1', 'bafyOld'), frame: 'frame-a' });
    send(null, { ...createAbortRequest('req-1'), frame: 'frame-a' });
    const newFrame = createFakeFrame();
    send(newFrame, { ...createGetRequest('req-2', 'bafyNew'), frame: 'frame-a' });
    await waitForLength(network.fetches);
    oldRead.release();
    await waitForLength(oldFrame.replies);

    // When the new frame leaves
    send(null, { ...createAbortRequest('req-2'), frame: 'frame-a' });

    // Then the fetch of its block stopped
    expect(network.fetches.find(fetch => fetch.cid === 'bafyNew')?.signal.aborted).toBe(true);
  });

  it("As a user, I drop a frame's request and its block is not counted in the loading bar", async () => {
    // Given a frame whose request was aborted while its cache read is pending
    const { channel, send } = createFakeChannel();
    const read = createDeferredRead();
    const relay = createSandboxBlockRelay({
      channel,
      blocks: createFakeNetwork(() => 'hold').blocks,
      cache: read.cache,
      verify: verifyBlock,
    });
    const progress: ContentProgress[] = [];
    relay.onProgress(update => progress.push(update));
    const frame = createFakeFrame();
    send(frame, { ...createGetRequest('req-1', 'bafyOld'), frame: 'frame-a' });
    send(null, { ...createAbortRequest('req-1'), frame: 'frame-a' });

    // When the cache read settles
    read.release();
    await waitForLength(frame.replies);

    // Then nothing was counted
    expect(progress).toEqual([]);
  });

  it('As the host, I stop the relay mid-fetch and the frame still gets its block', async () => {
    // Given a fetch the network is still answering
    const answer = createDeferred<Uint8Array>();
    const { channel, send } = createFakeChannel();
    const relay = createSandboxBlockRelay({
      channel,
      blocks: () => answer.promise,
      cache: null,
      verify: verifyBlock,
    });
    const frame = createFakeFrame();
    send(frame, createGetRequest('req-1'));

    // When the relay stops and the network answers
    relay.stop();
    answer.resolve(BLOCK.slice());
    await waitForLength(frame.replies);

    // Then
    expect(frame.replies).toEqual([{ type: 'dotli:bitswap-result', id: 'req-1', ok: true, bytes: BLOCK }]);
  });

  it('As the host, I stop the relay and it stops listening to the channel', () => {
    // Given
    const { channel, listeners } = createFakeChannel();
    const relay = createSandboxBlockRelay({
      channel,
      blocks: createFakeNetwork().blocks,
      cache: null,
      verify: verifyBlock,
    });

    // When
    relay.stop();

    // Then
    expect(listeners()).toBe(0);
  });
});

describe('createSandboxBlockRelay with a block cache', () => {
  it('As a user, I open an app I opened before and its blocks load without the network', async () => {
    // Given a relay with a cache, and one load that fetched the block
    const network = createFakeNetwork();
    const { channel, send } = createFakeChannel();
    const relay = createSandboxBlockRelay({
      channel,
      blocks: network.blocks,
      cache: createMemoryCache(),
      verify: verifyBlock,
    });
    const served: string[] = [];
    relay.onServed(from => served.push(from));
    const firstLoad = createFakeFrame();
    send(firstLoad, createGetRequest('req-1'));
    await waitForLength(firstLoad.replies);

    // When the app loads again
    const secondLoad = createFakeFrame();
    send(secondLoad, createGetRequest('req-1'));
    await waitForLength(secondLoad.replies);

    // Then the block came from the cache, whole, although the first reply transferred its buffer away
    expect(network.fetches).toHaveLength(1);
    expect(secondLoad.replies).toHaveLength(1);
    expect(secondLoad.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(served).toEqual(['network', 'cache']);
  });

  it('As a user, I get a cached block that no longer matches its CID fetched again, not served', async () => {
    // Given a cache holding corrupted bytes for the block
    const network = createFakeNetwork();
    const cache = createMemoryCache([['bafyBlock', new Uint8Array([0x00])]]);
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({ channel, blocks: network.blocks, cache, verify: verifyBlock });

    // When
    const frame = createFakeFrame();
    send(frame, createGetRequest('req-1'));
    await waitForLength(frame.replies);

    // Then
    expect(frame.replies).toHaveLength(1);
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(network.fetches).toHaveLength(1);
    expect(cache.deleted).toEqual(['bafyBlock']);
    expect(cache.blocks.get('bafyBlock')).toEqual(BLOCK);
  });

  it('As a sandbox asking for a block a peer forged, I get a verification failure and the block is not served', async () => {
    // Given a network that hands back bytes of some other block
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const cache = createMemoryCache();
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: createFakeNetwork(() => new Uint8Array([0x01, 0x02])).blocks,
      cache,
      verify: verifyBlock,
    });

    // When
    const frame = createFakeFrame();
    send(frame, createGetRequest('req-1'));
    await waitForLength(frame.replies);

    // Then the sandbox gets a failure named for verification, nothing is kept, and the mismatch is counted
    expect(frame.replies).toEqual([
      {
        type: 'dotli:bitswap-result',
        id: 'req-1',
        ok: false,
        // Vitest types the matcher `any`, widened so no `any` reaches the expected object.
        error: expect.stringContaining('bafyBlock') as unknown,
        errorName: 'ContentVerificationError',
      },
    ]);
    expect(cache.writes).toBe(0);
    expect(captured).toMatchObject([{ step: 'relay_verify', tags: { cid: 'bafyBlock' } }]);
    expect(sentry.counted('content.block_relay')).toEqual([{ outcome: 'error', reason: 'mismatch', step: 'verify' }]);
  });

  it('As a sandbox with the archive cache off, I get a verification failure for a forged block too', async () => {
    // Given
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: createFakeNetwork(() => new Uint8Array([0x01, 0x02])).blocks,
      cache: null,
      verify: verifyBlock,
    });

    // When
    const frame = createFakeFrame();
    send(frame, createGetRequest('req-1'));
    await waitForLength(frame.replies);

    // Then
    expect(frame.replies).toHaveLength(1);
    expect(frame.replies[0]).toMatchObject({ ok: false, errorName: 'ContentVerificationError' });
  });

  it('As a user, I still load the app when the block cache cannot be read', async () => {
    // Given a cache whose reads fail
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const network = createFakeNetwork();
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: network.blocks,
      cache: createMemoryCache([], { get: new Error('QuotaExceededError') }),
      verify: verifyBlock,
    });

    // When
    const frame = createFakeFrame();
    send(frame, createGetRequest('req-1'));
    await waitForLength(frame.replies);

    // Then the block came from the network, and the failed read was reported
    expect(frame.replies).toHaveLength(1);
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(network.fetches).toHaveLength(1);
    expect(captured).toMatchObject([{ step: 'relay_cache_read', tags: undefined }]);
    expect(sentry.counted('content.block_relay')).toEqual([{ outcome: 'error', reason: 'Error', step: 'cache_read' }]);
  });

  it('As a user, I get no block when the verifier fails to load, the cached copy is kept for a later check, and nothing is written', async () => {
    // Given a cache already holding the block, but a verifier whose chunk cannot load
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const network = createFakeNetwork();
    const cache = createMemoryCache([['bafyBlock', BLOCK.slice()]]);
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: network.blocks,
      cache,
      verify: () => Promise.reject(new Error('verify chunk failed to load')),
    });

    // When
    const frame = createFakeFrame();
    send(frame, createGetRequest('req-1'));
    await waitForLength(frame.replies);

    // Then the cached copy was neither trusted nor dropped, the fetched copy could not be checked either, so the
    // sandbox gets a verification failure and nothing was written
    expect(network.fetches).toHaveLength(1);
    expect(frame.replies).toHaveLength(1);
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
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: createFakeNetwork().blocks,
      cache: null,
      verify: () => Promise.reject(missing),
    });

    // When two blocks are asked for
    const frame = createFakeFrame();
    send(frame, createGetRequest('req-1'));
    send(frame, createGetRequest('req-2'));
    await waitForLength(frame.replies, 2);

    // Then both are refused, each miss leaves a breadcrumb and a count, and none is captured
    expect(frame.replies).toMatchObject([
      { ok: false, errorName: 'ContentVerificationError' },
      { ok: false, errorName: 'ContentVerificationError' },
    ]);
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledTimes(2);
    expect(captures.expected).toHaveBeenCalledWith(missing, expect.objectContaining({ step: 'relay_verify' }));
    const verifyFailure = { outcome: 'error', reason: 'Error', step: 'verify' };
    expect(sentry.counted('content.block_relay')).toEqual([verifyFailure, verifyFailure]);
  });

  it('As a user, I ask again once the verifier loads on a later try and my next block is checked and served', async () => {
    // Given a verifier whose first load fails, as during a deploy, and whose next one works
    let checks = 0;
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: createFakeNetwork().blocks,
      cache: null,
      verify: (cid, bytes) => {
        checks += 1;
        return checks === 1 ? Promise.reject(new Error('verify chunk failed to load')) : verifyBlock(cid, bytes);
      },
    });

    // When the sandbox asks, is refused, and asks again
    const frame = createFakeFrame();
    send(frame, createGetRequest('req-1'));
    await waitForLength(frame.replies);
    send(frame, createGetRequest('req-2'));
    await waitForLength(frame.replies, 2);

    // Then the first is refused and the second is checked and served
    expect(frame.replies).toMatchObject([
      { id: 'req-1', ok: false, errorName: 'ContentVerificationError' },
      { id: 'req-2', ok: true, bytes: BLOCK },
    ]);
  });

  it('As a user, I am still served the fetched block when dropping a corrupted cached block fails', async () => {
    // Given a cache holding corrupted bytes whose delete fails
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const reported = createRecording<true>();
    const sentry = bindRecordingSentry({
      onFinished: onTestFinished,
      onRecord: () => reported.push(true),
    });
    const network = createFakeNetwork();
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: network.blocks,
      cache: createMemoryCache([['bafyBlock', new Uint8Array([0x00])]], { delete: new Error('delete failed') }),
      verify: verifyBlock,
    });

    // When
    const frame = createFakeFrame();
    send(frame, createGetRequest('req-1'));
    await waitForLength(frame.replies);
    await waitForLength(reported);

    // Then the block came from the network, and the failed delete was reported once
    expect(frame.replies).toHaveLength(1);
    expect(reported).toHaveLength(1);
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(network.fetches).toHaveLength(1);
    expect(captured).toMatchObject([{ step: 'relay_cache_delete', tags: undefined }]);
    expect(sentry.counted('content.block_relay')).toEqual([
      { outcome: 'error', reason: 'Error', step: 'cache_delete' },
    ]);
  });

  it('As a user, I am still served the fetched block when the block cache write rejects', async () => {
    // Given a cache whose writes fail
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const reported = createRecording<true>();
    const sentry = bindRecordingSentry({
      onFinished: onTestFinished,
      onRecord: () => reported.push(true),
    });
    const { channel, send } = createFakeChannel();
    createSandboxBlockRelay({
      channel,
      blocks: createFakeNetwork().blocks,
      cache: createMemoryCache([], { put: new Error('write failed') }),
      verify: verifyBlock,
    });

    // When
    const frame = createFakeFrame();
    send(frame, createGetRequest('req-1'));
    await waitForLength(frame.replies);
    await waitForLength(reported);

    // Then the block was served, and the failed write was reported once it settled
    expect(frame.replies).toHaveLength(1);
    expect(reported).toHaveLength(1);
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(captured).toMatchObject([{ step: 'relay_cache_write', tags: undefined }]);
    expect(sentry.counted('content.block_relay')).toEqual([{ outcome: 'error', reason: 'Error', step: 'cache_write' }]);
  });
});

describe('createSandboxBlockRelay progress', () => {
  /** These blocks are sized for the progress count, so they are not any one real block. */
  const acceptAnyBlock: RelayParams['verify'] = () => Promise.resolve(true);
  /** A dag-pb root whose two links carry a Tsize of 100 and 50. */
  const ROOT = new Uint8Array([0x12, 0x02, 0x18, 100, 0x12, 0x02, 0x18, 50]);

  it("As a user, I see the first block's links give the total, and the speed count from that block", async () => {
    // Given a clock that moves 500 ms between the two blocks
    let clock = 1_000;
    const { channel, send } = createFakeChannel();
    const relay = createSandboxBlockRelay({
      channel,
      blocks: createFakeNetwork(cid => (cid === 'bafyRoot' ? ROOT.slice() : new Uint8Array(100))).blocks,
      cache: null,
      verify: acceptAnyBlock,
      now: () => clock,
    });
    const progress = createRecording<ContentProgress>();
    relay.onProgress(update => progress.push(update));

    // When
    send(createFakeFrame(), createGetRequest('req-1', 'bafyRoot'));
    await waitForLength(progress);
    clock += 500;
    send(createFakeFrame(), createGetRequest('req-2', 'bafyLeaf'));
    await waitForLength(progress, 2);

    // Then
    expect(progress).toEqual([
      { bytesFetched: ROOT.length, totalBytes: 150, bytesPerSecond: 0 },
      { bytesFetched: ROOT.length + 100, totalBytes: 150, bytesPerSecond: ((ROOT.length + 100) / 500) * 1000 },
    ]);
  });

  it('As a user whose load is retried, I watch the bar and it counts from zero again rather than past the total', async () => {
    // Given a relay that served a root and one leaf
    const { channel, send } = createFakeChannel();
    const relay = createSandboxBlockRelay({
      channel,
      blocks: createFakeNetwork(cid => (cid === 'bafyRoot' ? ROOT.slice() : new Uint8Array(100))).blocks,
      cache: null,
      verify: acceptAnyBlock,
    });
    const progress = createRecording<ContentProgress>();
    relay.onProgress(update => progress.push(update));
    send(createFakeFrame(), createGetRequest('req-1', 'bafyRoot'));
    await waitForLength(progress);
    send(createFakeFrame(), createGetRequest('req-2', 'bafyLeaf'));
    await waitForLength(progress, 2);

    // When the retry walks from the root again
    send(createFakeFrame(), createGetRequest('req-3', 'bafyRoot'));
    await waitForLength(progress, 3);

    // Then the third update starts over at the root
    expect(progress.map(({ bytesFetched, totalBytes }) => ({ bytesFetched, totalBytes }))).toEqual([
      { bytesFetched: ROOT.length, totalBytes: 150 },
      { bytesFetched: ROOT.length + 100, totalBytes: 150 },
      { bytesFetched: ROOT.length, totalBytes: 150 },
    ]);
  });

  it('As a user, I get my block even when a progress or served listener throws, and the other listeners still hear it', async () => {
    // Given a throwing listener ahead of a working one on each of the two feeds
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { channel, send } = createFakeChannel();
    const relay = createSandboxBlockRelay({
      channel,
      blocks: createFakeNetwork().blocks,
      cache: null,
      verify: acceptAnyBlock,
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
    const frame = createFakeFrame();

    // When a block is served
    send(frame, createGetRequest('req-1'));
    await waitForLength(frame.replies);

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
