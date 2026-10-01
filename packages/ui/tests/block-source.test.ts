// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Subject } from 'rxjs';

type OnHalt = (reason: 'chain' | 'frame') => void;
type Remote = (onMessage: (message: string) => void, onHalt?: OnHalt) => unknown;

interface FakeClient {
  bestBlocks$: Subject<{ number: number }[]>;
  destroy: Mock<() => void>;
}

const mocks = vi.hoisted(() => ({
  hostChainProvider: vi.fn<(genesisHash: string) => Remote | null>(),
  createClient: vi.fn(),
  onProtocolReady: vi.fn(),
  isProtocolReady: vi.fn<() => boolean>(),
}));

vi.mock('@dotli/protocol', () => ({
  onProtocolReady: mocks.onProtocolReady,
  isProtocolReady: mocks.isProtocolReady,
}));
vi.mock('../src/host-callbacks/Chain.js', () => ({ hostChainProvider: mocks.hostChainProvider }));
vi.mock('polkadot-api', () => ({ createClient: mocks.createClient }));

import { createBlockSource } from '../src/block-source.js';

const GENESIS = `0x${'ab'.repeat(32)}`;

describe('network block source', () => {
  let clients: FakeClient[];
  let halts: OnHalt[];
  let readyListeners: (() => void)[];
  let unreadied: Mock<() => void>;
  let onBlock: Mock<(n: number) => void>;

  const live = (): number => clients.filter(c => c.destroy.mock.calls.length === 0).length;
  const halt = (reason: 'chain' | 'frame'): void => {
    const last = halts.at(-1);
    if (last === undefined) {
      throw new Error('no connection');
    }
    last(reason);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clients = [];
    halts = [];
    readyListeners = [];
    unreadied = vi.fn<() => void>();
    onBlock = vi.fn<(n: number) => void>();
    const remote: Remote = (_onMessage, onHalt) => {
      if (onHalt !== undefined) {
        halts.push(onHalt);
      }
      return { send: vi.fn(), disconnect: vi.fn() };
    };
    mocks.hostChainProvider.mockReset().mockReturnValue(remote);
    mocks.createClient.mockReset().mockImplementation((provider: (m: () => void) => unknown) => {
      provider(() => undefined);
      const client: FakeClient = { bestBlocks$: new Subject(), destroy: vi.fn<() => void>() };
      clients.push(client);
      return client;
    });
    mocks.isProtocolReady.mockReset().mockReturnValue(true);
    mocks.onProtocolReady.mockReset().mockImplementation((listener: () => void) => {
      readyListeners.push(listener);
      return unreadied;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function start(): Promise<() => void> {
    const stop = createBlockSource().subscribe(GENESIS, onBlock);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
    return stop;
  }

  it('As a dotli integrator, a bar unsubscribed before its watch loads dials nothing', async () => {
    // Given: a bar subscribed and left at once.
    const stop = createBlockSource().subscribe(GENESIS, onBlock);
    stop();

    // When: the watch module arrives.
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);

    // Then: no client was dialled.
    expect(mocks.hostChainProvider).not.toHaveBeenCalled();
    expect(clients).toHaveLength(0);
  });

  it("As a dotli user, a chain's block bar comes back after its chain halts", async () => {
    // Given: a watched chain delivering a block.
    await start();
    clients[0]?.bestBlocks$.next([{ number: 5 }]);

    // When: the chain halts.
    halt('chain');

    // Then: the client is gone, a new one comes at 1000 ms and its blocks arrive.
    expect(clients[0]?.destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(clients).toHaveLength(2);
    clients[1]?.bestBlocks$.next([{ number: 6 }]);
    expect(onBlock).toHaveBeenLastCalledWith(6);
  });

  it('As a dotli user, a chain that keeps halting is retried less and less often', async () => {
    // Given: a watched chain.
    await start();

    // When / Then: three halts without blocks wait 1000, 2000, 4000 ms.
    for (const [i, wait] of [1000, 2000, 4000].entries()) {
      halt('chain');
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(clients).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(clients).toHaveLength(i + 2);
    }

    // And: a block resets the wait to 1000 ms.
    clients[3]?.bestBlocks$.next([{ number: 1 }]);
    halt('chain');
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients).toHaveLength(5);

    // And: the wait never exceeds 30 s.
    for (let i = 0; i < 7; i++) {
      halt('chain');
      await vi.advanceTimersByTimeAsync(30_000);
    }
    const before = clients.length;
    halt('chain');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(clients).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(clients).toHaveLength(before + 1);
    expect(live()).toBe(1);
  });

  it('As a dotli user, a bar waits for the protocol frame to come back after it died', async () => {
    // Given: a watched chain whose frame dies.
    await start();
    halt('frame');

    // When: a minute passes.
    await vi.advanceTimersByTimeAsync(60_000);

    // Then: nothing was dialled until the frame reports ready.
    expect(clients).toHaveLength(1);
    readyListeners[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(2);
    expect(live()).toBe(1);
    expect(unreadied).toHaveBeenCalled();
  });

  it('As a dotli user, a bar in its backoff does not boot a protocol frame that died meanwhile', async () => {
    // Given: a chain that halted and is waiting out its backoff.
    await start();
    halt('chain');

    // When: the frame dies before the wait ends.
    mocks.isProtocolReady.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(60_000);

    // Then: nothing was dialled until the frame reports ready.
    expect(clients).toHaveLength(1);
    expect(mocks.hostChainProvider).toHaveBeenCalledTimes(1);
    readyListeners[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(2);
    expect(live()).toBe(1);
    expect(unreadied).toHaveBeenCalled();
  });

  it('As a dotli integrator, an unsubscribed bar stops reconnecting', async () => {
    // Given: a halted chain in backoff, and another waiting for its frame.
    const stop = await start();
    halt('chain');

    // When: the subscriber leaves.
    stop();
    await vi.advanceTimersByTimeAsync(60_000);

    // Then: no client is dialled.
    expect(clients).toHaveLength(1);

    // And: a bar waiting for the frame releases its ready subscription.
    const stopWaiting = await start();
    halt('frame');
    stopWaiting();
    expect(unreadied).toHaveBeenCalled();
    expect(live()).toBe(0);
  });

  it('As a dotli user, a late halt from a replaced client does not start a second one', async () => {
    // Given: a chain that halted and reconnected.
    await start();
    const first = halts[0];
    halt('chain');
    await vi.advanceTimersByTimeAsync(1000);

    // When: the old connection reports its halt again.
    first?.('chain');
    await vi.advanceTimersByTimeAsync(60_000);

    // Then: exactly one client is live.
    expect(clients).toHaveLength(2);
    expect(live()).toBe(1);
  });
});
