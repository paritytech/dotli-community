import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blake2b } from '@noble/hashes/blake2.js';
import { createPreimageAdapters } from '../src/host-callbacks/Preimage.js';
import type { bitswapGet } from '@dotli/content';
import { yielded } from './support.js';

const mocks = vi.hoisted(() => ({
  fetchFromIpfs: vi.fn(() => Promise.resolve({ data: new Uint8Array() })),
  bitswapGet: vi.fn<typeof bitswapGet>(() => Promise.resolve(new Uint8Array())),
  getBackend: vi.fn(() => 'rpc-gateway'),
  getCacheNodeSettings: vi.fn(() => ({ enabled: false, providersUrl: '', payerSeed: '' })),
}));

vi.mock('../../content/src/ipfs.js', () => ({
  fetchFromIpfs: mocks.fetchFromIpfs,
}));

vi.mock('../../content/src/bitswap.js', () => ({
  bitswapGet: mocks.bitswapGet,
}));

vi.mock('../../config/src/mode.js', () => ({
  getBackend: mocks.getBackend,
  getCacheNodeSettings: mocks.getCacheNodeSettings,
}));

describe('preimage host callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchFromIpfs.mockResolvedValue({ data: new Uint8Array() });
    mocks.bitswapGet.mockResolvedValue(new Uint8Array());
    mocks.getBackend.mockReturnValue('rpc-gateway');
    mocks.getCacheNodeSettings.mockReturnValue({ enabled: false, providersUrl: '', payerSeed: '' });
  });

  it('As a reader with cache nodes on, the host reads a preimage from a cache node at once, and Bulletin is not asked', async () => {
    // Given a provider set with one cache node that has the value
    vi.useFakeTimers();
    const data = new TextEncoder().encode('a preimage that a cache node keeps');
    const key = blake2b(data, { dkLen: 32 });
    const node = { id: '07'.repeat(32), api: 'http://cache-node', name: 'A', region: 'local' };
    mocks.getCacheNodeSettings.mockReturnValue({ enabled: true, providersUrl: 'http://set/providers', payerSeed: '' });
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url === 'http://set/providers') {
        return Promise.resolve(Response.json([node]));
      }
      if (url === 'http://cache-node/acquire') {
        return Promise.resolve(new Response(data, { status: 200, headers: { 'x-cache-origin': 'local' } }));
      }
      return Promise.resolve(Response.json('Charged'));
    });
    try {
      const { lookupPreimage } = createPreimageAdapters('myapp');

      // When the product looks the key up, and no poll interval passes
      const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
      await iterator.next();
      const foundPromise = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      const found = await foundPromise;
      await iterator.return?.();

      // Then the cache node served it, was paid with a receipt, and the Bulletin backend was never asked
      expect({
        value: yielded(found)._unsafeUnwrap(),
        urls,
        bulletin: mocks.fetchFromIpfs.mock.calls.length,
      }).toEqual({
        value: data,
        urls: ['http://set/providers', 'http://cache-node/acquire', 'http://cache-node/receipt'],
        bulletin: 0,
      });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('As a dotli integrator, the host emits a miss immediately for an uncached lookup', async () => {
    // Given
    const { lookupPreimage } = createPreimageAdapters('myapp');
    const missingKey = new Uint8Array(32);

    // When
    const iterator = lookupPreimage(missingKey)[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    // Then
    expect(first.done).toBe(false);
    expect(yielded(first).isOk()).toBe(true);
    expect(yielded(first)._unsafeUnwrap()).toBeUndefined();
  });

  it('only exposes the lookup callback (submission is core-owned)', () => {
    const adapters = createPreimageAdapters('myapp');
    expect(typeof adapters.lookupPreimage).toBe('function');
    expect('submitPreimage' in adapters).toBe(false);
  });

  it('As a dotli integrator, the host retries transient lookup backend failures', async () => {
    // Given
    vi.useFakeTimers();
    try {
      const { lookupPreimage } = createPreimageAdapters('myapp');
      const found = new TextEncoder().encode('retried preimage');
      const key = blake2b(found, { dkLen: 32 });
      mocks.fetchFromIpfs.mockRejectedValueOnce(new Error('gateway unavailable'));
      mocks.fetchFromIpfs.mockResolvedValueOnce({ data: found });

      // When
      const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
      const first = await iterator.next();
      const secondPromise = iterator.next();
      let secondSettled = false;
      void secondPromise.then(() => {
        secondSettled = true;
      });
      await vi.advanceTimersByTimeAsync(1000);

      // Then
      expect(first.done).toBe(false);
      expect(yielded(first).isOk()).toBe(true);
      expect(yielded(first)._unsafeUnwrap()).toBeUndefined();
      expect(secondSettled).toBe(false);
      expect(mocks.fetchFromIpfs).toHaveBeenCalledTimes(1);

      // When
      await vi.advanceTimersByTimeAsync(9_000);

      // Then
      const second = await secondPromise;
      expect(second.done).toBe(false);
      expect(yielded(second).isOk()).toBe(true);
      expect(yielded(second)._unsafeUnwrap()).toEqual(found);
      expect(mocks.fetchFromIpfs).toHaveBeenCalledTimes(2);
      await iterator.return?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a dotli integrator, the host caches a gateway preimage only after hash verification', async () => {
    // Given
    vi.useFakeTimers();
    try {
      const data = new TextEncoder().encode('verified gateway preimage');
      const key = blake2b(data, { dkLen: 32 });
      mocks.fetchFromIpfs.mockResolvedValue({ data });
      const { lookupPreimage } = createPreimageAdapters('myapp');

      // When
      const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
      await iterator.next();
      const foundPromise = iterator.next();
      await vi.advanceTimersByTimeAsync(1000);
      const found = await foundPromise;
      await iterator.return?.();

      // Then
      expect(found.done).toBe(false);
      expect(yielded(found).isOk()).toBe(true);
      expect(yielded(found)._unsafeUnwrap()).toEqual(data);

      // When
      const cached = await lookupPreimage(key)[Symbol.asyncIterator]().next();

      // Then
      expect(cached.done).toBe(false);
      expect(yielded(cached).isOk()).toBe(true);
      expect(yielded(cached)._unsafeUnwrap()).toEqual(data);
      expect(mocks.fetchFromIpfs).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['rpc-gateway', 'smoldot-direct'] as const)(
    'As a product, the host rejects and does not cache corrupt data from %s',
    async backend => {
      // Given
      vi.useFakeTimers();
      try {
        const expected = new TextEncoder().encode(`expected preimage from ${backend}`);
        const corrupt = new TextEncoder().encode('corrupt preimage');
        const key = blake2b(expected, { dkLen: 32 });
        mocks.getBackend.mockReturnValue(backend);
        mocks.fetchFromIpfs.mockResolvedValue({ data: corrupt });
        mocks.bitswapGet.mockResolvedValue(corrupt);
        const { lookupPreimage } = createPreimageAdapters('myapp');

        // When
        const firstIterator = lookupPreimage(key)[Symbol.asyncIterator]();
        await firstIterator.next();
        const firstErrorPromise = firstIterator.next();
        await vi.advanceTimersByTimeAsync(1000);
        const firstError = await firstErrorPromise;

        // Then
        expect(firstError.done).toBe(false);
        expect(yielded(firstError).isErr()).toBe(true);
        expect(yielded(firstError)._unsafeUnwrapErr().reason).toContain('Content hash mismatch');

        // When
        const secondIterator = lookupPreimage(key)[Symbol.asyncIterator]();
        const secondMiss = await secondIterator.next();
        const secondErrorPromise = secondIterator.next();
        await vi.advanceTimersByTimeAsync(1000);
        const secondError = await secondErrorPromise;

        // Then
        expect(yielded(secondMiss)._unsafeUnwrap()).toBeUndefined();
        expect(yielded(secondError).isErr()).toBe(true);
        const fetch = backend === 'rpc-gateway' ? mocks.fetchFromIpfs : mocks.bitswapGet;
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('As a user, a slow preimage lookup does not stack another on every poll tick', async () => {
    // Given a lookup that outlives several 10s poll intervals, which bitswapGet
    // can now do while it retries a CID whose providers have not attached
    vi.useFakeTimers();
    try {
      mocks.getBackend.mockReturnValue('smoldot-direct');
      let release: (v: Uint8Array) => void = () => undefined;
      mocks.bitswapGet.mockImplementation(
        () =>
          new Promise<Uint8Array>(resolve => {
            release = resolve;
          }),
      );
      const { lookupPreimage } = createPreimageAdapters('myapp');
      const key = new Uint8Array(32).fill(7);

      // When four poll ticks pass while the first lookup is still in flight
      const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
      await iterator.next();
      await vi.advanceTimersByTimeAsync(45_000);

      // Then only the first tick issued a request
      expect(mocks.bitswapGet).toHaveBeenCalledTimes(1);

      release(new Uint8Array());
      await iterator.return?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a user, dropping a preimage subscription cancels the lookup it left running', async () => {
    // Given a lookup that is still retrying when the product lets go
    vi.useFakeTimers();
    try {
      mocks.getBackend.mockReturnValue('smoldot-direct');
      let handed: AbortSignal | undefined;
      mocks.bitswapGet.mockImplementation((_cid: string, signal?: AbortSignal) => {
        handed = signal;
        return new Promise<Uint8Array>(() => undefined);
      });
      const { lookupPreimage } = createPreimageAdapters('myapp');
      const key = new Uint8Array(32).fill(9);

      // When the subscription is torn down mid-lookup
      const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
      await iterator.next();
      await vi.advanceTimersByTimeAsync(1500);
      expect(handed?.aborted).toBe(false);
      await iterator.return?.();

      // Then the host stops fetching for a consumer that has gone
      expect(handed?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
