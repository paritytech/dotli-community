// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The installed substrate client runs over a scripted chainHead server, optionally behind the protocol broker. The
// server rejects reads at unpinned blocks and records any unpin of a block an operation is still reading.

import { describe, expect, it } from 'vitest';
import { createClient, type SubstrateClient } from '@polkadot-api/substrate-client';
import type { JsonRpcMessage, JsonRpcProvider, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { toHex } from '@polkadot-api/utils';
import { createChainPool } from '../../protocol/src/chain-pool.js';
import { readMappingAddress, readMappingBytes, readNestedMappingString } from '../src/access-raw-storage.js';
import { ApiStoppedError, createRawApi, type Api } from '../src/api.js';
import { PartialStorageReadError } from '../src/errors.js';

const ADDRESS = `0x${'11'.repeat(20)}`;
const KEY = `0x${'22'.repeat(32)}` as const;
/** `Revive::AccountInfoOf` for a contract whose child trie id is `0xaa`. */
const ACCOUNT = '0x0004aa';

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Expected a harness value');
  }
  return value;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface Operation {
  id: string;
  hash: string;
  child: unknown;
  key: string;
}

interface Chain {
  token: string;
  pinned: Set<string>;
  operations: Map<string, Operation>;
  reads: Operation[];
  active: boolean;
}

interface StorageServer {
  client: SubstrateClient;
  chains: Chain[];
  violations: string[];
  event: (chain: Chain, result: Record<string, unknown>) => void;
  failNextUnpin: () => void;
  /** A further follow on the same client, ready once the server (or the broker's replay) initializes it. */
  join: () => Promise<Api>;
  open: (hashes?: string[]) => Promise<{ api: Api; chain: Chain }>;
  waitReads: (chain: Chain, count: number) => Promise<void>;
  complete: (chain: Chain, index: number, value: string | null, error?: string) => void;
  advance: (chain: Chain, hash: string, parent: string, pruned?: string[]) => void;
}

function server(shared = false): StorageServer {
  const chains: Chain[] = [];
  const violations: string[] = [];
  let listener!: (message: JsonRpcMessage) => void;
  let counter = 0;
  let failUnpin = false;
  const waiters: { chain: Chain; count: number; resolve: () => void }[] = [];

  function event(chain: Chain, result: Record<string, unknown>): void {
    if (result['event'] === 'initialized') {
      for (const hash of result['finalizedBlockHashes'] as string[]) {
        chain.pinned.add(hash);
      }
    } else if (result['event'] === 'newBlock') {
      chain.pinned.add(result['blockHash'] as string);
    } else if (result['event'] === 'stop') {
      chain.active = false;
      chain.pinned.clear();
      chain.operations.clear();
    }
    listener({ jsonrpc: '2.0', method: 'chainHead_v1_followEvent', params: { subscription: chain.token, result } });
  }

  function reply(request: JsonRpcRequest, message: { result: unknown } | { error: unknown }): void {
    listener({ jsonrpc: '2.0', id: required(request.id), ...message } as JsonRpcMessage);
  }

  const provider: JsonRpcProvider = onMessage => {
    listener = onMessage;
    return {
      send(request) {
        const params = request.params as unknown[];
        if (request.method === 'chainHead_v1_follow') {
          const chain: Chain = {
            token: `follow-${String(chains.length)}`,
            pinned: new Set(),
            operations: new Map(),
            reads: [],
            active: true,
          };
          chains.push(chain);
          queueMicrotask(() => {
            reply(request, { result: chain.token });
          });
          return;
        }
        const chain = chains.find(entry => entry.token === params[0]);
        // Releases under a stale subscription are specified no-ops.
        if (
          chain === undefined &&
          (request.method === 'chainHead_v1_unfollow' || request.method === 'chainHead_v1_unpin')
        ) {
          return;
        }
        if (chain === undefined) {
          throw new Error(`Unknown follow token for ${request.method}`);
        }
        if (request.method === 'chainHead_v1_unfollow') {
          chain.active = false;
          chain.pinned.clear();
          chain.operations.clear();
          return;
        }
        if (request.method === 'chainHead_v1_unpin') {
          if (failUnpin) {
            failUnpin = false;
            queueMicrotask(() => {
              reply(request, { error: { code: -32801, message: 'Unpin failed' } });
            });
            return;
          }
          for (const hash of params[1] as string[]) {
            if (!chain.active || !chain.pinned.delete(hash)) {
              violations.push(`invalid unpin ${hash}`);
            }
            if ([...chain.operations.values()].some(op => op.hash === hash)) {
              violations.push(`active unpin ${hash}`);
            }
          }
          queueMicrotask(() => {
            reply(request, { result: null });
          });
          return;
        }
        if (request.method === 'chainHead_v1_stopOperation') {
          chain.operations.delete(params[1] as string);
          return;
        }
        if (request.method !== 'chainHead_v1_storage') {
          throw new Error(request.method);
        }
        const hash = params[1] as string;
        if (!chain.active || !chain.pinned.has(hash)) {
          reply(request, { error: { code: -32801, message: 'Block not pinned' } });
          return;
        }
        const op = {
          id: `op-${String(counter++)}`,
          hash,
          child: params[3],
          key: required((params[2] as { key: string }[])[0]).key,
        };
        chain.operations.set(op.id, op);
        chain.reads.push(op);
        queueMicrotask(() => {
          reply(request, { result: { result: 'started', operationId: op.id, discardedItems: 0 } });
          for (let i = waiters.length - 1; i >= 0; i--) {
            const waiter = required(waiters[i]);
            if (waiter.chain === chain && chain.reads.length >= waiter.count) {
              waiters.splice(i, 1);
              waiter.resolve();
            }
          }
        });
      },
      disconnect() {
        /* nothing to release */
      },
    };
  };

  const pool = shared ? createChainPool({ createTransport: () => provider, destroyDelay: Infinity }) : null;
  const client = createClient(pool?.getLocalProvider('test-chain') ?? provider);
  return {
    client,
    chains,
    violations,
    event,
    failNextUnpin() {
      failUnpin = true;
    },
    async join() {
      const api = createRawApi(client);
      await api.whenReady();
      return api;
    },
    async open(hashes = ['root']) {
      const api = createRawApi(client);
      const chain = required(chains.at(-1));
      await Promise.resolve(); // the follow token arrives before `initialized`
      event(chain, { event: 'initialized', finalizedBlockHashes: hashes });
      await api.whenReady();
      return { api, chain };
    },
    waitReads(chain, count) {
      if (chain.reads.length >= count) {
        return Promise.resolve();
      }
      return new Promise<void>(resolve => waiters.push({ chain, count, resolve }));
    },
    complete(chain, index, value, error) {
      const op = required(chain.reads[index]);
      if (!chain.operations.delete(op.id)) {
        throw new Error('Operation already ended');
      }
      if (!chain.pinned.has(op.hash)) {
        throw new Error('Storage block released before completion');
      }
      if (error !== undefined) {
        event(chain, { event: 'operationError', operationId: op.id, error });
        return;
      }
      if (value !== null) {
        event(chain, { event: 'operationStorageItems', operationId: op.id, items: [{ key: op.key, value }] });
      }
      event(chain, { event: 'operationStorageDone', operationId: op.id });
    },
    advance(chain, hash, parent, pruned = []) {
      event(chain, { event: 'newBlock', blockHash: hash, parentBlockHash: parent });
      event(chain, { event: 'bestBlockChanged', bestBlockHash: hash });
      event(chain, { event: 'finalized', finalizedBlockHashes: [hash], prunedBlockHashes: pruned });
    },
  };
}

/** A long Solidity `bytes` slot header for `length` bytes. */
function longSlot(length: number): string {
  const bytes = new Uint8Array(32);
  bytes[31] = length * 2 + 1;
  return toHex(bytes);
}

describe('raw API block ownership over a real chainHead client', () => {
  it('As a dotli user, a resolver that reads nothing still releases finalized history as the chain moves on', async () => {
    // Given
    const h = server();
    const { api, chain } = await h.open(['ancestor', 'root']);

    // When
    for (let i = 1; i <= 100; i++) {
      h.advance(chain, `block-${String(i)}`, i === 1 ? 'root' : `block-${String(i - 1)}`);
      await Promise.resolve();
    }

    // Then
    expect([...chain.pinned]).toEqual(['block-100']);
    expect(h.violations).toEqual([]);
    api.destroy();
    h.client.destroy();
  });

  it('As a dotli user, overlapping multi-slot reads each finish on the block they began on while that fork is pruned', async () => {
    // Given: two reads begin on a fork that is then pruned
    const h = server();
    const { api, chain } = await h.open();
    h.event(chain, { event: 'newBlock', blockHash: 'fork', parentBlockHash: 'root' });
    h.event(chain, { event: 'bestBlockChanged', bestBlockHash: 'fork' });
    const first = readMappingBytes(api, ADDRESS, KEY, 0);
    const second = readNestedMappingString(api, ADDRESS, KEY, 'manifest', 0);
    await h.waitReads(chain, 2);

    // When
    h.advance(chain, 'winner', 'root', ['fork']);
    await Promise.resolve();
    h.complete(chain, 0, ACCOUNT);
    h.complete(chain, 1, ACCOUNT);
    await h.waitReads(chain, 4);
    h.complete(chain, 2, longSlot(40));
    h.complete(chain, 3, longSlot(40));
    await h.waitReads(chain, 6);
    h.complete(chain, 4, toHex(new Uint8Array(32).fill(65)));
    await h.waitReads(chain, 7);
    h.complete(chain, 6, toHex(new Uint8Array(32).fill(66)));

    // Then: the fork stays pinned until the last read on it ends
    expect(await first).toEqual(new Uint8Array([...new Uint8Array(32).fill(65), ...new Uint8Array(8).fill(66)]));
    expect(chain.pinned.has('fork')).toBe(true);
    h.complete(chain, 5, toHex(new Uint8Array(32).fill(67)));
    await h.waitReads(chain, 8);
    h.complete(chain, 7, toHex(new Uint8Array(32).fill(68)));
    expect(await second).toBe('C'.repeat(32) + 'D'.repeat(8));
    expect(new Set(chain.reads.map(op => op.hash))).toEqual(new Set(['fork']));
    expect([...chain.pinned]).toEqual(['winner']);
    expect(h.violations).toEqual([]);
    api.destroy();
    h.client.destroy();
  });

  it('As a dotli user, an owner lookup keeps its block while a redeploy gives the next lookup a fresh contract trie', async () => {
    // Given
    const h = server();
    const { api, chain } = await h.open();
    const first = readMappingAddress(api, ADDRESS, KEY, 0);
    await h.waitReads(chain, 1);
    h.complete(chain, 0, ACCOUNT);
    await h.waitReads(chain, 2);

    // When: the contract is redeployed in the next block, and a second lookup starts there
    h.advance(chain, 'redeployed', 'root');
    const second = readMappingAddress(api, ADDRESS, KEY, 0);
    await h.waitReads(chain, 3);
    h.complete(chain, 2, '0x0004bb');
    await h.waitReads(chain, 4);

    // Then
    expect([...chain.pinned]).toEqual(['root', 'redeployed']);
    expect(chain.reads.map(({ hash, child }) => ({ hash, child }))).toEqual([
      { hash: 'root', child: null },
      { hash: 'root', child: '0xaa' },
      { hash: 'redeployed', child: null },
      { hash: 'redeployed', child: '0xbb' },
    ]);
    h.complete(chain, 1, `0x${'00'.repeat(12)}${'11'.repeat(20)}`);
    expect(await first).toBe(`0x${'11'.repeat(20)}`);
    expect([...chain.pinned]).toEqual(['redeployed']);
    h.complete(chain, 3, `0x${'00'.repeat(12)}${'22'.repeat(20)}`);
    expect(await second).toBe(`0x${'22'.repeat(20)}`);
    expect(h.violations).toEqual([]);
    api.destroy();
    h.client.destroy();
  });

  it('As a dotli user, a missing contract, a failed read and a partial read each release their block', async () => {
    // Given
    const h = server();
    const { api, chain } = await h.open();

    // When / Then: a contract that does not exist
    const missing = readMappingBytes(api, ADDRESS, KEY, 0);
    await h.waitReads(chain, 1);
    h.advance(chain, 'next', 'root');
    h.complete(chain, 0, null);
    expect(await missing).toBeNull();
    expect([...chain.pinned]).toEqual(['next']);

    // When / Then: a read the node fails
    const failed = readMappingBytes(api, ADDRESS, KEY, 0);
    const rejected = expect(failed).rejects.toThrow('storage unavailable');
    await h.waitReads(chain, 2);
    h.advance(chain, 'last', 'next');
    h.complete(chain, 1, null, 'storage unavailable');
    await rejected;
    expect([...chain.pinned]).toEqual(['last']);

    // When / Then: a multi-slot read whose second slot is missing
    const partial = readMappingBytes(api, ADDRESS, KEY, 0);
    const partialRejected = expect(partial).rejects.toBeInstanceOf(PartialStorageReadError);
    await h.waitReads(chain, 3);
    h.complete(chain, 2, ACCOUNT);
    await h.waitReads(chain, 4);
    h.complete(chain, 3, longSlot(40));
    await h.waitReads(chain, 5);
    h.advance(chain, 'tip', 'last');
    h.complete(chain, 4, null);
    await partialRejected;
    expect([...chain.pinned]).toEqual(['tip']);
    expect(h.violations).toEqual([]);
    api.destroy();
    h.client.destroy();
  });

  it('As a dotli user, destroying the resolver follow fails its reads at once and a stale read cannot touch the replacement', async () => {
    // Given: one read paused between storage calls, one waiting on the node, and an owner that destroys on stop
    const h = server();
    const { api, chain } = await h.open();
    let stops = 0;
    api.onStop(() => {
      stops++;
      api.destroy();
    });
    const resume = deferred();
    const entered = deferred();
    let staleRead!: Promise<Uint8Array | null>;
    const waiting = api.withBestBlock(async hash => {
      const trie = await api.resolveTrieId(ADDRESS, hash);
      entered.resolve();
      await resume.promise;
      staleRead = api.readSlot(ADDRESS, KEY, hash, trie ?? undefined);
      return staleRead;
    });
    const waitingRejected = expect(waiting).rejects.toBeInstanceOf(ApiStoppedError);
    await h.waitReads(chain, 1);
    h.complete(chain, 0, ACCOUNT);
    await entered.promise;
    const pending = readMappingBytes(api, ADDRESS, KEY, 0);
    const pendingRejected = expect(pending).rejects.toBeInstanceOf(ApiStoppedError);
    await h.waitReads(chain, 2);

    // When
    api.destroy();
    api.destroy();

    // Then
    await pendingRejected;
    expect(stops).toBe(1);
    expect(chain.active).toBe(false);
    await expect(api.whenReady()).rejects.toBeInstanceOf(ApiStoppedError);
    const replacement = await h.open(['replacement']);
    resume.resolve();
    await waitingRejected;
    await expect(staleRead).rejects.toBeInstanceOf(ApiStoppedError);
    const fresh = readMappingAddress(replacement.api, ADDRESS, KEY, 0);
    await h.waitReads(replacement.chain, 1);
    h.complete(replacement.chain, 0, ACCOUNT);
    await h.waitReads(replacement.chain, 2);
    h.complete(replacement.chain, 1, `0x${'00'.repeat(12)}${'33'.repeat(20)}`);
    expect(await fresh).toBe(`0x${'33'.repeat(20)}`);
    expect(chain.reads).toHaveLength(2);
    expect(h.violations).toEqual([]);
    replacement.api.destroy();
    h.client.destroy();
  });

  it('As a dotli user, a follow the node stops fails its reads as stopped, and one destroyed before it is ready never becomes ready', async () => {
    // Given
    const h = server();
    const { api, chain } = await h.open();
    const read = readMappingBytes(api, ADDRESS, KEY, 0);
    const rejected = expect(read).rejects.toBeInstanceOf(ApiStoppedError);
    await h.waitReads(chain, 1);

    // When
    h.event(chain, { event: 'stop' });

    // Then
    await rejected;
    let lateStops = 0;
    api.onStop(() => {
      lateStops++;
    });
    api.destroy();
    expect(lateStops).toBe(1);
    const early = createRawApi(h.client);
    early.destroy();
    await expect(early.whenReady()).rejects.toBeInstanceOf(ApiStoppedError);
    await expect(readMappingBytes(early, ADDRESS, KEY, 0)).rejects.toBeInstanceOf(ApiStoppedError);
    h.client.destroy();
  });

  it.each([
    ['directly', false],
    ['through the broker', true],
  ])(
    'As a dotli user, a block the node refuses to unpin %s ends the follow so the resolver redials',
    async (_case, shared) => {
      // Given
      const h = server(shared);
      const { api, chain } = await h.open();
      h.failNextUnpin();

      // When
      h.advance(chain, 'next', 'root');
      const read = readMappingBytes(api, ADDRESS, KEY, 0);

      // Then
      await expect(read).rejects.toBeInstanceOf(ApiStoppedError);
      expect(chain.active).toBe(false);
      expect(chain.operations.size).toBe(0);
      await expect(api.whenReady()).rejects.toBeInstanceOf(ApiStoppedError);
      h.client.destroy();
    },
  );

  it('As a dotli user joining a shared follow late, I can read a fork the node later makes best, and it stays pinned until I finish', async () => {
    // Given: a long-lived follow with two forks above the newest finalized block
    const h = server(true);
    const { api, chain } = await h.open(['ancestor', 'root']);
    for (let i = 1; i <= 30; i++) {
      h.advance(chain, `b${String(i)}`, i === 1 ? 'root' : `b${String(i - 1)}`);
      await Promise.resolve();
    }
    h.event(chain, { event: 'newBlock', blockHash: 'other', parentBlockHash: 'b30' });
    h.event(chain, { event: 'newBlock', blockHash: 'best', parentBlockHash: 'b30' });
    h.event(chain, { event: 'bestBlockChanged', bestBlockHash: 'best' });
    await Promise.resolve();
    expect(chain.pinned).toEqual(new Set(['b30', 'other', 'best']));

    // When: a late follower reads after best moves to the other fork, which is then pruned
    const late = await h.join();
    h.event(chain, { event: 'bestBlockChanged', bestBlockHash: 'other' });
    const read = readMappingAddress(late, ADDRESS, KEY, 0);
    await h.waitReads(chain, 1);
    h.complete(chain, 0, ACCOUNT);
    await h.waitReads(chain, 2);
    h.event(chain, { event: 'bestBlockChanged', bestBlockHash: 'best' });
    h.event(chain, { event: 'finalized', finalizedBlockHashes: ['best'], prunedBlockHashes: ['other'] });
    await Promise.resolve();

    // Then
    expect(chain.pinned.has('other')).toBe(true);
    h.complete(chain, 1, `0x${'00'.repeat(12)}${'44'.repeat(20)}`);
    expect(await read).toBe(`0x${'44'.repeat(20)}`);
    expect(chain.reads.map(op => op.hash)).toEqual(['other', 'other']);
    expect(chain.pinned).toEqual(new Set(['best']));
    expect(h.violations).toEqual([]);
    late.destroy();
    api.destroy();
    h.client.destroy();
  });

  it('As a dotli user, re-following from inside a broker stop reads on the new follow, not the dead pins', async () => {
    // Given
    const h = server(true);
    const { api, chain } = await h.open();
    let replacement!: Promise<Api>;
    api.onStop(() => {
      replacement = h.join();
    });

    // When
    h.event(chain, { event: 'stop' });
    const next = required(h.chains.at(-1));
    expect(next).not.toBe(chain);
    await Promise.resolve();
    h.event(next, { event: 'initialized', finalizedBlockHashes: ['root'] });
    const fresh = await replacement;
    const read = readMappingAddress(fresh, ADDRESS, KEY, 0);
    await h.waitReads(next, 1);
    h.complete(next, 0, ACCOUNT);
    await h.waitReads(next, 2);
    h.complete(next, 1, `0x${'00'.repeat(12)}${'55'.repeat(20)}`);

    // Then
    expect(await read).toBe(`0x${'55'.repeat(20)}`);
    expect(next.pinned).toEqual(new Set(['root']));
    expect(h.violations).toEqual([]);
    fresh.destroy();
    h.client.destroy();
  });
});
