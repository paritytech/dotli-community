// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's chain pool end to end (Chain.ts, pool, broker, backend transport), with remote connections faked.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, setBackend } from '@dotli/config';
import type * as SharedModule from '@dotli/shared';
import type { RemoteChainHalt, RemoteChainProvider } from '@dotli/protocol';
import { FakeWebSocket } from '../../resolver/tests/fake-websocket.js';
import type * as ClientModule from '../../protocol/src/client.js';
import type * as ChainModule from '../src/host-callbacks/Chain.js';
import { hexBytes, must, yielded } from './support.js';

interface RemoteConnection {
  genesisHash: string;
  sent: JsonRpcRequest[];
  emit: (message: JsonRpcMessage) => void;
  halt: (reason: RemoteChainHalt) => void;
  disconnect: Mock<() => void>;
}

const mocks = vi.hoisted(() => {
  // The frame gate subscribes once per module, so each test's fresh module adds its own.
  const readyListeners: (() => void)[] = [];
  return {
    createRemoteChainProvider: vi.fn<(genesisHash: string) => RemoteChainProvider | null>(),
    isProtocolReady: vi.fn<() => boolean>(),
    isProtocolBooting: vi.fn<() => boolean>(),
    // The real client of the current module graph, for a test that boots a frame.
    actualClient: null as typeof ClientModule | null,
    readyListeners,
    onProtocolReady: vi.fn<(listener: () => void) => () => void>(listener => {
      readyListeners.push(listener);
      return () => undefined;
    }),
  };
});

vi.mock('../../protocol/src/client.js', async importOriginal => {
  const actual = await importOriginal<typeof ClientModule>();
  mocks.actualClient = actual;
  return {
    ...actual,
    createRemoteChainProvider: mocks.createRemoteChainProvider,
    isProtocolReady: mocks.isProtocolReady,
    isProtocolBooting: mocks.isProtocolBooting,
    onProtocolReady: mocks.onProtocolReady,
  };
});

// The protocol iframe's host does not exist here. Stop happy-dom fetching it, but keep `contentWindow`.
(
  window as unknown as { happyDOM: { settings: { navigation: { disableChildFrameNavigation: boolean } } } }
).happyDOM.settings.navigation.disableChildFrameNavigation = true;

/** The protocol frame reports ready, which ends the host pool's frame-gate wait. */
function frameReady(): void {
  mocks.isProtocolBooting.mockReturnValue(false);
  mocks.isProtocolReady.mockReturnValue(true);
  for (const listener of mocks.readyListeners) {
    listener();
  }
}

const people = getActiveServicesConfig().people.genesis;
const assetHub = getActiveServicesConfig().assethub.genesis;

let createChainConnect: typeof ChainModule.createChainConnect;
let createHostChainPool: typeof ChainModule.createHostChainPool;
let hostChainProvider: typeof ChainModule.hostChainProvider;
let log: typeof SharedModule.log;

// Chain.ts keeps its gates at module level, so a fresh module gives each test a fresh page's gates.
beforeEach(async () => {
  vi.resetModules();
  mocks.readyListeners.length = 0;
  ({ createChainConnect, createHostChainPool, hostChainProvider } = await import('../src/host-callbacks/Chain.js'));
  ({ log } = await import('@dotli/shared'));
});

describe('host chain pool on a light client backend', () => {
  let remotes: RemoteConnection[];
  // How each new remote connection fares. `worker`: refused, as by the SharedWorker after a permanent fatal.
  // `direct`: the frame reports ready, then its light client fails. `answering`: as `direct`, but it answers the first
  // request and fails 1.5 s later. `chain`: the chain halts at once.
  let refuse: 'none' | 'worker' | 'direct' | 'answering' | 'chain';

  beforeEach(() => {
    vi.useFakeTimers();
    setBackend('smoldot-direct');
    remotes = [];
    refuse = 'none';
    mocks.isProtocolReady.mockReturnValue(false);
    mocks.isProtocolBooting.mockReturnValue(false);
    mocks.createRemoteChainProvider.mockReset().mockImplementation(genesisHash => (onMessage, onHalt) => {
      const remote: RemoteConnection = {
        genesisHash,
        sent: [],
        emit: onMessage,
        halt: reason => onHalt?.(reason),
        disconnect: vi.fn<() => void>(),
      };
      remotes.push(remote);
      if (refuse !== 'none') {
        const mode = refuse;
        queueMicrotask(() => {
          if (mode === 'chain') {
            remote.halt('chain');
            return;
          }
          if (mode === 'answering') {
            frameReady();
            const id = remote.sent[0]?.id;
            if (id !== undefined && id !== null) {
              remote.emit({ jsonrpc: '2.0', id, result: 'People' });
            }
            setTimeout(() => {
              mocks.isProtocolReady.mockReturnValue(false);
              remote.halt('frame');
            }, 1_500);
            return;
          }
          if (mode === 'direct') {
            frameReady();
            mocks.isProtocolReady.mockReturnValue(false);
          }
          remote.halt('frame');
        });
      }
      const connection: JsonRpcConnection = {
        send: message => remote.sent.push(message),
        disconnect: remote.disconnect,
      };
      return connection;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  const ask = (connection: { send: (request: string) => void }, id: string): void => {
    connection.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'chainSpec_v1_chainName', params: [] }));
  };

  it("As a dotli user, products' connections to one chain share one connection to the protocol frame", async () => {
    // Given
    const connect = createChainConnect(createHostChainPool());

    // When
    const first = await connect(hexBytes(people));
    const second = await connect(hexBytes(people));

    // Then
    expect(mocks.createRemoteChainProvider).toHaveBeenCalledTimes(1);
    expect(mocks.createRemoteChainProvider).toHaveBeenCalledWith(people.toLowerCase());
    expect(remotes).toHaveLength(1);
    first.close();
    second.close();
  });

  it("As a dotli user, a block bar shares the products' connection to the protocol frame", async () => {
    // Given
    const pool = createHostChainPool();
    const connect = createChainConnect(pool);
    const first = await connect(hexBytes(people));
    const second = await connect(hexBytes(people));

    // When
    const bar = must(hostChainProvider(people, pool), 'provider')(() => undefined);

    // Then
    expect(mocks.createRemoteChainProvider).toHaveBeenCalledTimes(1);
    expect(remotes).toHaveLength(1);
    first.close();
    second.close();
    bar.disconnect();
  });

  it.each(['chain', 'frame'] as const)(
    'As a dotli user, a %s halt of the connection to the protocol frame reaches a block bar with its reason',
    async reason => {
      // Given
      const pool = createHostChainPool();
      const product = await createChainConnect(pool)(hexBytes(people));
      const onHalt = vi.fn<(reason: RemoteChainHalt) => void>();
      must(hostChainProvider(people, pool), 'provider')(() => undefined, onHalt);

      // When
      must(remotes[0], 'remote').halt(reason);

      // Then
      expect(onHalt).toHaveBeenCalledTimes(1);
      expect(onHalt).toHaveBeenCalledWith(reason);
      product.close();
    },
  );

  it('As a dotli user, a chain the protocol frame cannot serve has no host provider', () => {
    // When
    const provider = hostChainProvider(`0x${'00'.repeat(32)}`, createHostChainPool());

    // Then
    expect(provider).toBeNull();
    expect(mocks.createRemoteChainProvider).not.toHaveBeenCalled();
  });

  it('As a dotli user, the connection to the protocol frame closes 60 seconds after its last lease', async () => {
    // Given
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    const remote = must(remotes[0], 'remote');

    // When
    connection.close();
    await vi.advanceTimersByTimeAsync(59_999);

    // Then
    expect(remote.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(remote.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([
    { reason: 'chain', ready: false },
    { reason: 'frame', ready: true },
  ] as const)(
    "As a dotli user, a product's chain connection outlives a $reason halt: what was queued arrives, and its next request opens a fresh connection to the frame",
    async ({ reason, ready }) => {
      // Given: a product request answered by the frame, not yet read (after
      // a frame halt, a frame something else started is up again).
      const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
      const responses = connection.responses()[Symbol.asyncIterator]();
      connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_chainName', params: [] }));
      const first = must(remotes[0], 'first remote');
      first.emit({ jsonrpc: '2.0', id: must(must(first.sent[0], 'request').id, 'id'), result: 'People' });

      // When: the connection to the frame halts, then the product asks again.
      first.halt(reason);
      if (ready) {
        frameReady();
      }
      connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:2', method: 'chainSpec_v1_chainName', params: [] }));

      // Then: the queued answer arrives, a new remote connection carries the
      // next request, and its answer reaches the same stream.
      expect(JSON.parse(yielded(await responses.next()))).toEqual({ jsonrpc: '2.0', id: 'truapi:1', result: 'People' });
      expect(remotes).toHaveLength(2);
      const second = must(remotes[1], 'second remote');
      expect(first.sent).toHaveLength(1);
      second.emit({ jsonrpc: '2.0', id: must(must(second.sent[0], 'request').id, 'id'), result: 'People again' });
      expect(JSON.parse(yielded(await responses.next()))).toEqual({
        jsonrpc: '2.0',
        id: 'truapi:2',
        result: 'People again',
      });
      connection.close();
      expect((await responses.next()).done).toBe(true);
    },
  );

  it('As a dotli user, a product retrying after the protocol frame died boots a new frame only as the backoff allows', async () => {
    // Given: the frame died, and every new frame refuses the connection.
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    must(remotes[0], 'first remote').halt('frame');
    refuse = 'worker';

    // When: the product's papi client retries every 250 ms for two minutes.
    for (let i = 0; i < 480; i++) {
      connection.send(
        JSON.stringify({ jsonrpc: '2.0', id: `truapi:${String(i)}`, method: 'chainHead_v1_follow', params: [true] }),
      );
      await vi.advanceTimersByTimeAsync(250);
    }

    // Then: a new frame is tried at 1, 3, 7, 15, 31, 61 and 91 s, and no more.
    expect(remotes).toHaveLength(8);
    connection.close();
  });

  it('As a dotli user, a request after the protocol frame died is answered at once while the backoff is shut', async () => {
    // Given
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(remotes[0], 'first remote').halt('frame');

    // When
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:2', method: 'chainSpec_v1_chainName', params: [] }));
    connection.send(JSON.stringify({ jsonrpc: '2.0', method: 'chainSpec_v1_chainName', params: [] }));

    // Then: the request gets the halted error, the notification nothing, and no frame is dialled.
    expect(JSON.parse(yielded(await responses.next()))).toEqual({
      jsonrpc: '2.0',
      id: 'truapi:2',
      error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
    });
    expect(remotes).toHaveLength(1);
    expect(mocks.createRemoteChainProvider).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it('As a dotli user, two products after the protocol frame died boot one frame per backoff window', async () => {
    // Given: the frame died, and every new frame refuses the connection.
    const connect = createChainConnect(createHostChainPool());
    const first = await connect(hexBytes(people));
    const second = await connect(hexBytes(people));
    must(remotes[0], 'first remote').halt('frame');
    refuse = 'worker';

    // When: the window opens, the first product's request boots a frame that
    // fails, and then the second product asks.
    await vi.advanceTimersByTimeAsync(1_000);
    first.send(JSON.stringify({ jsonrpc: '2.0', id: 'a:1', method: 'chainSpec_v1_chainName', params: [] }));
    await vi.advanceTimersByTimeAsync(0);
    second.send(JSON.stringify({ jsonrpc: '2.0', id: 'b:1', method: 'chainSpec_v1_chainName', params: [] }));

    // Then: only the first one dialled.
    expect(remotes).toHaveLength(2);
    expect(must(remotes[1], 'second remote').sent).toHaveLength(1);
    first.close();
    second.close();
  });

  it('As a dotli user, a product asking while another boots a protocol frame is answered once the frame is up', async () => {
    // Given: the frame died, and the first product's retry through the window
    // boots a new one.
    const connect = createChainConnect(createHostChainPool());
    const onPeople = await connect(hexBytes(people));
    const onAssetHub = await connect(hexBytes(assetHub));
    const responses = onAssetHub.responses()[Symbol.asyncIterator]();
    must(remotes[0], 'People').halt('frame');
    must(remotes[1], 'Asset Hub').halt('frame');
    await vi.advanceTimersByTimeAsync(1_000);
    ask(onPeople, 'p:1');
    expect(remotes).toHaveLength(3);
    mocks.isProtocolBooting.mockReturnValue(true);

    // When: the second product asks during that boot.
    ask(onAssetHub, 'a:1');

    // Then: its request goes out at once, to wait on the frame that is
    // booting, and is answered once that frame is up.
    expect(remotes).toHaveLength(4);
    const waiting = must(remotes[3], 'Asset Hub on the booting frame');
    expect(waiting.genesisHash).toBe(assetHub.toLowerCase());
    expect(waiting.sent).toHaveLength(1);
    frameReady();
    waiting.emit({ jsonrpc: '2.0', id: must(must(waiting.sent[0], 'request').id, 'id'), result: 'Asset Hub' });
    expect(JSON.parse(yielded(await responses.next()))).toEqual({ jsonrpc: '2.0', id: 'a:1', result: 'Asset Hub' });
    onPeople.close();
    onAssetHub.close();
  });

  it('As a dotli user, a product asking after the frame it waited on gave up waits for the frame gate', async () => {
    // Given: the frame died, and a new one, started by the real client, loads
    // but never reports ready; the product's retry waits on it.
    const client = must(mocks.actualClient, 'protocol client');
    mocks.isProtocolBooting.mockImplementation(client.isProtocolBooting);
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    must(remotes[0], 'first remote').halt('frame');
    const boot = client.ensureProtocolFrame().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    document.querySelector('iframe')?.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(0);
    ask(connection, 'truapi:1');
    expect(remotes).toHaveLength(2);

    // When: its ready wait times out, which halts the connection waiting on it.
    await vi.advanceTimersByTimeAsync(240_000);
    await boot;
    must(remotes[1], 'second remote').halt('frame');
    ask(connection, 'truapi:2');

    // Then: the frame gate is asked, not passed: shut for 1 s, then open.
    expect(remotes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    ask(connection, 'truapi:3');
    expect(remotes).toHaveLength(3);
    connection.close();
    client.resetProtocolFrame();
  });

  it('As a dotli user on smoldot-direct, a light client that fails right after its frame comes back keeps the doubled backoff', async () => {
    // Given: the frame died, and every new frame reports ready, then fails.
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    must(remotes[0], 'first remote').halt('frame');
    refuse = 'direct';

    // When: the product's papi client retries every 250 ms for two minutes.
    for (let i = 0; i < 480; i++) {
      ask(connection, `truapi:${String(i)}`);
      await vi.advanceTimersByTimeAsync(250);
    }

    // Then: a new frame is tried at 1, 3, 7, 15, 31, 61 and 91 s, as when
    // no frame ever comes back.
    expect(remotes).toHaveLength(8);
    connection.close();
  });

  it('As a dotli user on smoldot-direct, a light client that answers and then fails soon after keeps the doubled backoff', async () => {
    // Given: the frame died, and every new frame comes up, answers, and dies 1.5 s later.
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    must(remotes[0], 'first remote').halt('frame');
    refuse = 'answering';

    // When: the product's papi client retries every 250 ms for two minutes.
    for (let i = 0; i < 480; i++) {
      ask(connection, `truapi:${String(i)}`);
      await vi.advanceTimersByTimeAsync(250);
    }

    // Then: the answers reset nothing; a new frame is tried at 1, 4.5, 10,
    // 19.5, 37, 68.5 and 100 s, the same count as a frame that never answers.
    expect(remotes).toHaveLength(8);
    connection.close();
  });

  it('As a dotli user, a frame that lived past 30 s gets its next window after 1 s', async () => {
    // Given: a frame halt, and a retry through the 1 s window that boots a
    // frame (the delay is now 2 s); that frame comes up and stays up 31 s.
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    must(remotes[0], 'first remote').halt('frame');
    await vi.advanceTimersByTimeAsync(1_000);
    ask(connection, 'truapi:1');
    expect(remotes).toHaveLength(2);
    frameReady();
    await vi.advanceTimersByTimeAsync(31_000);

    // When: that frame dies.
    mocks.isProtocolReady.mockReturnValue(false);
    must(remotes[1], 'second remote').halt('frame');

    // Then: the next window is 1 s away, not 2 s.
    await vi.advanceTimersByTimeAsync(999);
    ask(connection, 'truapi:2');
    expect(remotes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    ask(connection, 'truapi:3');
    expect(remotes).toHaveLength(3);
    connection.close();
  });

  it('As a dotli user, a refusal by a live frame long ago does not let its later death boot a frame at once', async () => {
    // Given: a live frame refused a connection, and the product re-leased.
    mocks.isProtocolReady.mockReturnValue(true);
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    must(remotes[0], 'first remote').halt('frame');
    ask(connection, 'truapi:1');
    expect(remotes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);

    // When: the frame really dies, and the product asks at once.
    mocks.isProtocolReady.mockReturnValue(false);
    must(remotes[1], 'second remote').halt('frame');
    ask(connection, 'truapi:2');

    // Then: no frame is booted until the window opens 1 s later.
    expect(remotes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    ask(connection, 'truapi:3');
    expect(remotes).toHaveLength(3);
    connection.close();
  });

  it('As a dotli user, a re-lease after a frame halt that finds no transport keeps the backoff', async () => {
    // Given: a frame halt, the window open, and no transport to be had.
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(remotes[0], 'first remote').halt('frame');
    await vi.advanceTimersByTimeAsync(1_000);
    mocks.createRemoteChainProvider.mockReturnValue(null);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    // When: the product asks twice.
    ask(connection, 'truapi:1');
    ask(connection, 'truapi:2');

    // Then: both are answered at once, and only the first tried for a lease.
    const halted = { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' };
    expect(JSON.parse(yielded(await responses.next()))).toEqual({ jsonrpc: '2.0', id: 'truapi:1', error: halted });
    expect(JSON.parse(yielded(await responses.next()))).toEqual({ jsonrpc: '2.0', id: 'truapi:2', error: halted });
    expect(mocks.createRemoteChainProvider).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[dot.li truapi-chain] no chain transport for ${people.toLowerCase()} after a halt`,
    );
    connection.close();
  });

  it('As a dotli user, a product retrying on a chain that halts right after each rebuild rebuilds it only as the backoff allows', async () => {
    // Given: the chain halted, and every rebuild of it halts at once.
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    must(remotes[0], 'first remote').halt('chain');
    refuse = 'chain';

    // When: the product's papi client retries every 250 ms for two minutes.
    for (let i = 0; i < 480; i++) {
      ask(connection, `truapi:${String(i)}`);
      await vi.advanceTimersByTimeAsync(250);
    }

    // Then: the chain is rebuilt at once, then at 1, 3, 7, 15, 31, 61 and
    // 91 s, the frame backoff's windows, and no more.
    expect(remotes).toHaveLength(9);
    connection.close();
  });

  it('As a dotli user, a request on a chain whose backoff is shut is answered at once', async () => {
    // Given: the chain halted, was rebuilt at once, and halted again.
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(remotes[0], 'first remote').halt('chain');
    ask(connection, 'truapi:1');
    expect(remotes).toHaveLength(2);
    must(remotes[1], 'second remote').halt('chain');

    // When
    ask(connection, 'truapi:2');
    connection.send(JSON.stringify({ jsonrpc: '2.0', method: 'chainSpec_v1_chainName', params: [] }));

    // Then: the request gets the halted error, the notification nothing, and
    // the chain is not rebuilt.
    const halted = { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' };
    expect(JSON.parse(yielded(await responses.next()))).toEqual({ jsonrpc: '2.0', id: 'truapi:1', error: halted });
    expect(JSON.parse(yielded(await responses.next()))).toEqual({ jsonrpc: '2.0', id: 'truapi:2', error: halted });
    expect(remotes).toHaveLength(2);
    connection.close();
  });

  it('As a dotli user, a chain that halts again within 30 s of its rebuild is rebuilt 1 s later', async () => {
    // Given: the chain halted, was rebuilt at once, and the rebuild lived 10 s.
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    must(remotes[0], 'first remote').halt('chain');
    ask(connection, 'truapi:1');
    expect(remotes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);

    // When
    must(remotes[1], 'second remote').halt('chain');

    // Then
    ask(connection, 'truapi:2');
    await vi.advanceTimersByTimeAsync(999);
    ask(connection, 'truapi:3');
    expect(remotes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    ask(connection, 'truapi:4');
    expect(remotes).toHaveLength(3);
    connection.close();
  });

  it('As a dotli user, a chain whose rebuild lived past 30 s is rebuilt at once after its next halt', async () => {
    // Given: the chain halted twice in a row, so its backoff has grown, and
    // the rebuild after that lived 31 s.
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    must(remotes[0], 'first remote').halt('chain');
    ask(connection, 'truapi:1');
    must(remotes[1], 'second remote').halt('chain');
    await vi.advanceTimersByTimeAsync(1_000);
    ask(connection, 'truapi:2');
    expect(remotes).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(31_000);

    // When
    must(remotes[2], 'third remote').halt('chain');
    ask(connection, 'truapi:3');

    // Then: rebuilt at once, and a halt right after waits 1 s again.
    expect(remotes).toHaveLength(4);
    must(remotes[3], 'fourth remote').halt('chain');
    await vi.advanceTimersByTimeAsync(999);
    ask(connection, 'truapi:4');
    expect(remotes).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    ask(connection, 'truapi:5');
    expect(remotes).toHaveLength(5);
    connection.close();
  });

  it("As a dotli user, one chain's backoff does not hold back another chain", async () => {
    // Given: People halted, was rebuilt at once, and halted again.
    const connect = createChainConnect(createHostChainPool());
    const onPeople = await connect(hexBytes(people));
    const onAssetHub = await connect(hexBytes(assetHub));
    const peopleRemotes = (): RemoteConnection[] => remotes.filter(r => r.genesisHash === people.toLowerCase());
    const assetHubRemotes = (): RemoteConnection[] => remotes.filter(r => r.genesisHash === assetHub.toLowerCase());
    must(peopleRemotes()[0], 'People').halt('chain');
    ask(onPeople, 'p:1');
    must(peopleRemotes()[1], 'rebuilt People').halt('chain');

    // When: Asset Hub halts, and both products ask.
    must(assetHubRemotes()[0], 'Asset Hub').halt('chain');
    ask(onAssetHub, 'a:1');
    ask(onPeople, 'p:2');

    // Then: Asset Hub is rebuilt at once, People waits for its own window.
    expect(assetHubRemotes()).toHaveLength(2);
    expect(peopleRemotes()).toHaveLength(2);
    onPeople.close();
    onAssetHub.close();
  });

  it('As a dotli user, two products after a chain halt share its rebuild, and wait together when it halts again', async () => {
    // Given
    const connect = createChainConnect(createHostChainPool());
    const first = await connect(hexBytes(people));
    const second = await connect(hexBytes(people));
    must(remotes[0], 'first remote').halt('chain');

    // When: both products ask.
    ask(first, 'a:1');
    ask(second, 'b:1');

    // Then: the first rebuilt the chain, and the second's request rides on it.
    expect(remotes).toHaveLength(2);
    expect(must(remotes[1], 'second remote').sent).toHaveLength(2);

    // When: the rebuild halts at once, and both ask again.
    must(remotes[1], 'second remote').halt('chain');
    ask(first, 'a:2');
    ask(second, 'b:2');

    // Then: neither rebuilds it before the window opens.
    expect(remotes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    ask(second, 'b:3');
    ask(first, 'a:3');
    expect(remotes).toHaveLength(3);
    expect(must(remotes[2], 'third remote').sent).toHaveLength(2);
    first.close();
    second.close();
  });

  it('As a dotli user, a block bar after a halt opens a fresh connection to the frame', () => {
    // Given
    const pool = createHostChainPool();
    const provider = must(hostChainProvider(people, pool), 'provider');
    provider(
      () => undefined,
      () => undefined,
    );
    must(remotes[0], 'first remote').halt('chain');

    // When
    const bar = provider(() => undefined);
    bar.send({ jsonrpc: '2.0', id: 'bar:1', method: 'chainSpec_v1_genesisHash', params: [] });

    // Then
    expect(remotes).toHaveLength(2);
    expect(must(remotes[1], 'second remote').sent).toHaveLength(1);
    bar.disconnect();
  });

  it('As a dotli user, the connection to the protocol frame closes 60 seconds after the last of two leases', async () => {
    // Given
    const connect = createChainConnect(createHostChainPool());
    const first = await connect(hexBytes(people));
    const second = await connect(hexBytes(people));
    const remote = must(remotes[0], 'remote');

    // When: one lease is released, and the other a while later.
    first.close();
    await vi.advanceTimersByTimeAsync(30_000);
    second.close();
    await vi.advanceTimersByTimeAsync(59_999);

    // Then: the countdown started at the second release.
    expect(remote.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(remote.disconnect).toHaveBeenCalledTimes(1);
  });

  it('As the network panel, a lease on the host pool shows its chain in use without the panel holding it', async () => {
    // Given
    const monitor = await import('../src/network-monitor.js');
    const identity = (): string | undefined => monitor.getNetworkStatus().find(chain => chain.key === 'people')?.state;
    expect(identity()).toBe('unused');

    // When
    const connection = must(hostChainProvider(people), 'provider')(() => undefined);

    // Then
    expect(identity()).not.toBe('unused');

    // When
    connection.disconnect();

    // Then
    expect(identity()).toBe('unused');
  });
});

describe('host chain pool over Trusted Providers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    FakeWebSocket.instances = [];
    setBackend('rpc-gateway');
    mocks.createRemoteChainProvider.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("As a dotli user on Trusted Providers, a block bar and a product's connection share one socket", async () => {
    // Given
    const pool = createHostChainPool();
    const product = await createChainConnect(pool)(hexBytes(people));
    const bar = must(hostChainProvider(people, pool), 'provider')(() => undefined);

    // When
    product.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_chainName', params: [] }));
    bar.send({ jsonrpc: '2.0', id: 'bar:1', method: 'chainSpec_v1_genesisHash', params: [] });
    await vi.advanceTimersByTimeAsync(0);
    must(FakeWebSocket.instances[0], 'socket').open();

    // Then
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = must(FakeWebSocket.instances[0], 'socket');
    expect(socket.requests('chainSpec_v1_chainName')).toHaveLength(1);
    expect(socket.requests('chainSpec_v1_genesisHash')).toHaveLength(1);
    expect(mocks.createRemoteChainProvider).not.toHaveBeenCalled();
    product.close();
    bar.disconnect();
  });
});
