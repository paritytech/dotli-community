// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { create as createDigest } from 'multiformats/hashes/digest';
import type { SandboxBitswapOptions } from '../src/bitswap.js';
import type * as ConfigModule from '../../config/src/config.js';

const mocks = vi.hoisted(() => ({
  createRemoteChainProvider: vi.fn(),
  isRemoteChainSupported: vi.fn(() => true),
  getBackend: vi.fn(() => 'smoldot-direct'),
  getActiveServicesConfig: vi.fn(() => ({ bulletin: { genesis: '0xbull' } })),
  isSandboxOrigin: vi.fn(() => true),
}));

vi.mock('../../protocol/src/client.js', () => ({
  createRemoteChainProvider: mocks.createRemoteChainProvider,
  isRemoteChainSupported: mocks.isRemoteChainSupported,
}));
vi.mock('../../config/src/mode.js', () => ({ getBackend: mocks.getBackend }));
vi.mock('../../config/src/network.js', () => ({
  getActiveServicesConfig: mocks.getActiveServicesConfig,
}));
vi.mock('../../config/src/config.js', async importOriginal => ({
  ...(await importOriginal<typeof ConfigModule>()),
  isSandboxOrigin: mocks.isSandboxOrigin,
}));

/** Stands in for the protocol iframe's smoldot: every get answers `hex`. */
function stubChain(hex: string): { sent: number } {
  const state = { sent: 0 };
  mocks.createRemoteChainProvider.mockImplementation(() => (onMessage: (m: unknown) => void) => ({
    send: (request: { id: number }) => {
      state.sent += 1;
      queueMicrotask(() => {
        onMessage({ jsonrpc: '2.0', id: request.id, result: hex });
      });
    },
    disconnect: () => undefined,
  }));
  return state;
}

interface Reply {
  ok: boolean;
  bytes?: Uint8Array;
}

/**
 * A sandbox frame that receives replies the way `postMessage` delivers them:
 * cloned, with every transferred buffer detached on the sender's side.
 */
function fakeFrame(): {
  replies: Reply[];
  postMessage: ReturnType<typeof vi.fn>;
} {
  const replies: Reply[] = [];
  return {
    replies,
    postMessage: vi.fn((message: unknown, options?: { transfer?: Transferable[] }) => {
      replies.push(
        structuredClone(message, {
          transfer: options?.transfer ?? [],
        }) as Reply,
      );
    }),
  };
}

interface MemoryCache {
  blocks: Map<string, Uint8Array>;
  get: Mock<(cid: string) => Promise<Uint8Array | null>>;
  put: Mock<(cid: string, bytes: Uint8Array) => Promise<void>>;
  delete: Mock<(cid: string) => Promise<void>>;
}

function memoryCache(initial: [string, Uint8Array][] = []): MemoryCache {
  const blocks = new Map(initial);
  return {
    blocks,
    // A copy, since the relay transfers the returned buffer and would detach this map's own.
    get: vi.fn((cid: string) => Promise.resolve(blocks.get(cid)?.slice() ?? null)),
    put: vi.fn((cid: string, bytes: Uint8Array) => {
      blocks.set(cid, bytes);
      return Promise.resolve();
    }),
    delete: vi.fn((cid: string) => {
      blocks.delete(cid);
      return Promise.resolve();
    }),
  };
}

const BLOCK = new Uint8Array([0xab, 0xcd]);
const BLOCK_HEX = '0xabcd';
let blockCid = '';

beforeAll(async () => {
  blockCid = CID.create(1, raw.code, await sha256.digest(BLOCK)).toString();
});

describe('listenForSandboxBitswap with a block cache', () => {
  let stop: () => void = () => {
    /* no relay installed yet */
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    stop();
    // Unconditional, so a failed assertion cannot leak a throwing "./verify" into later tests.
    vi.doUnmock('../src/verify.js');
  });

  async function startRelay(options: SandboxBitswapOptions): Promise<void> {
    const { listenForSandboxBitswap } = await import('../src/bitswap.js');
    stop = listenForSandboxBitswap(options);
  }

  function request(frame: unknown, id: string): void {
    window.dispatchEvent(
      Object.assign(
        new MessageEvent('message', {
          data: { type: 'dotli:bitswap-get', id, cid: blockCid },
        }),
        { source: frame, origin: 'https://a.app.dot.li' },
      ),
    );
  }

  it('As a user, an app I opened before loads its blocks without the network', async () => {
    // Given a relay with a cache, and one load that fetched the block
    const chain = stubChain(BLOCK_HEX);
    const cache = memoryCache();
    const served: string[] = [];
    await startRelay({
      blockCache: cache,
      onBlockServed: from => served.push(from),
    });
    const firstLoad = fakeFrame();
    request(firstLoad, 'req-1');
    await vi.waitFor(() => {
      expect(firstLoad.replies).toHaveLength(1);
    });

    // When the app loads again
    const secondLoad = fakeFrame();
    request(secondLoad, 'req-1');
    await vi.waitFor(() => {
      expect(secondLoad.replies).toHaveLength(1);
    });

    // Then the block came from the cache, whole, although the first reply
    // transferred its buffer away
    expect(chain.sent).toBe(1);
    expect(secondLoad.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(served).toEqual(['network', 'cache']);
  });

  it('As a user, a cached block that no longer matches its CID is fetched again, not served', async () => {
    // Given a cache holding corrupted bytes for the block
    const chain = stubChain(BLOCK_HEX);
    const cache = memoryCache([[blockCid, new Uint8Array([0x00])]]);
    await startRelay({ blockCache: cache });

    // When
    const frame = fakeFrame();
    request(frame, 'req-1');
    await vi.waitFor(() => {
      expect(frame.replies).toHaveLength(1);
    });

    // Then
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(chain.sent).toBe(1);
    expect(cache.delete).toHaveBeenCalledWith(blockCid);
    expect(cache.blocks.get(blockCid)).toEqual(BLOCK);
  });

  it('As a user, bytes that do not match their CID are never kept', async () => {
    // Given a chain that hands back bytes of some other block
    stubChain('0x0102');
    const cache = memoryCache();
    await startRelay({ blockCache: cache });

    // When
    const frame = fakeFrame();
    request(frame, 'req-1');
    await vi.waitFor(() => {
      expect(frame.replies).toHaveLength(1);
    });

    // Then
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('As a user, a block cache that cannot be read still loads the app', async () => {
    // Given
    const chain = stubChain(BLOCK_HEX);
    const cache = memoryCache();
    cache.get.mockRejectedValue(new Error('QuotaExceededError'));
    await startRelay({ blockCache: cache });

    // When
    const frame = fakeFrame();
    request(frame, 'req-1');
    await vi.waitFor(() => {
      expect(frame.replies).toHaveLength(1);
    });

    // Then
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(chain.sent).toBe(1);
  });

  it('As a user with the archive cache off, every block comes from the network', async () => {
    // Given
    const chain = stubChain(BLOCK_HEX);
    await startRelay({});

    // When the same block is asked for twice
    const first = fakeFrame();
    request(first, 'req-1');
    await vi.waitFor(() => {
      expect(first.replies).toHaveLength(1);
    });
    const second = fakeFrame();
    request(second, 'req-1');
    await vi.waitFor(() => {
      expect(second.replies).toHaveLength(1);
    });

    // Then
    expect(chain.sent).toBe(2);
  });

  it('As a user, a verifier module that fails to load treats a cached block as a miss', async () => {
    // Given a cache already holding the block, but a verifier that cannot be
    // imported
    vi.doMock('../src/verify.js', () => {
      throw new Error('verify module failed to load');
    });
    const chain = stubChain(BLOCK_HEX);
    const cache = memoryCache([[blockCid, BLOCK.slice()]]);
    await startRelay({ blockCache: cache });

    // When
    const frame = fakeFrame();
    request(frame, 'req-1');
    await vi.waitFor(() => {
      expect(frame.replies).toHaveLength(1);
    });

    // Then the cached copy was not trusted, so the block was fetched fresh
    expect(chain.sent).toBe(1);
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
  });

  it('As a user, a verifier module that fails to load still serves a freshly fetched block, unstored', async () => {
    // Given a verifier that cannot be imported
    vi.doMock('../src/verify.js', () => {
      throw new Error('verify module failed to load');
    });
    const chain = stubChain(BLOCK_HEX);
    const cache = memoryCache();
    await startRelay({ blockCache: cache });

    // When
    const frame = fakeFrame();
    request(frame, 'req-1');
    await vi.waitFor(() => {
      expect(frame.replies).toHaveLength(1);
    });

    // Then the network bytes were still handed to the sandbox, but the
    // unverifiable block was never written to the cache
    expect(chain.sent).toBe(1);
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('As a user, a CID with an unsupported multihash is served from the network but never cached', async () => {
    // Given a CID built on a multihash the verifier cannot recompute
    // (identity, 0x00)
    const unsupportedDigest = createDigest(0x00, BLOCK);
    const unsupportedCid = CID.create(1, raw.code, unsupportedDigest).toString();
    const chain = stubChain(BLOCK_HEX);
    const cache = memoryCache();
    await startRelay({ blockCache: cache });

    // When
    const frame = fakeFrame();
    window.dispatchEvent(
      Object.assign(
        new MessageEvent('message', {
          data: {
            type: 'dotli:bitswap-get',
            id: 'req-1',
            cid: unsupportedCid,
          },
        }),
        { source: frame, origin: 'https://a.app.dot.li' },
      ),
    );
    await vi.waitFor(() => {
      expect(frame.replies).toHaveLength(1);
    });

    // Then
    expect(chain.sent).toBe(1);
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('As a user, an unparseable CID is served (as it is today) but never cached', async () => {
    // Given a request whose "cid" does not parse as a CID at all
    const chain = stubChain(BLOCK_HEX);
    const cache = memoryCache();
    await startRelay({ blockCache: cache });

    // When
    const frame = fakeFrame();
    window.dispatchEvent(
      Object.assign(
        new MessageEvent('message', {
          data: {
            type: 'dotli:bitswap-get',
            id: 'req-1',
            cid: 'not-a-cid',
          },
        }),
        { source: frame, origin: 'https://a.app.dot.li' },
      ),
    );
    await vi.waitFor(() => {
      expect(frame.replies).toHaveLength(1);
    });

    // Then
    expect(chain.sent).toBe(1);
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('As a user, a block cache write that rejects still serves the fetched block', async () => {
    // Given a cache whose put always rejects
    const chain = stubChain(BLOCK_HEX);
    const cache = memoryCache();
    cache.put.mockRejectedValue(new Error('write failed'));
    await startRelay({ blockCache: cache });

    // When
    const frame = fakeFrame();
    request(frame, 'req-1');
    await vi.waitFor(() => {
      expect(frame.replies).toHaveLength(1);
    });

    // Then
    expect(chain.sent).toBe(1);
    expect(frame.replies[0]).toMatchObject({ ok: true, bytes: BLOCK });
  });
});
