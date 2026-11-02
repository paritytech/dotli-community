// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { JsonRpcConnection, JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getSettings, setSettings } from '@dotli/config';
import type { ChainPool } from '@dotli/chains';
import { FakeWebSocket } from '@dotli/chains/testing';
import { fromHex, isRecord } from '@dotli/shared';
import { must } from '@dotli/shared/testing';
import {
  createFakeHostChainSources,
  createFakeRemoteChains,
  createFakeSocketChain,
  type FakeHostChainSources,
  type FakeRemoteChains,
  type RemoteConnection,
} from './createHostChainPool.fake.js';
import { createChainConnect } from './createChainConnect.js';
import { createHostChainPool, type FrameStatusSource } from './createHostChainPool.js';
import { yielded } from '../../testing/fixtures.js';

type Params = {
  /** How long an idle chain stays open. Unset, the pool's default minute. */
  destroyDelay?: number;
};

const READY_FRAME: FrameStatusSource = { getProtocolStatus: () => 'ready' };

const HALTED = { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' };

const FILTER = [{ matchAny: [`0x${'ab'.repeat(32)}`] }];

describe('createChainConnect', () => {
  let people: string;
  let assetHub: string;
  let sources: FakeHostChainSources;

  beforeEach(() => {
    people = getActiveServicesConfig().people.genesis;
    assetHub = getActiveServicesConfig().assethub.genesis;
    sources = createFakeHostChainSources();
  });

  it('As an operator, I watch a re-lease that finds no transport and it is counted', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const connection = await createProductConnect(sources, { destroyDelay: 0 })(fromHex(people));
    onTestFinished(() => {
      connection.close();
    });
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(sources.upstreams[0], 'upstream').halt();
    sources.createRemoteChain.mockReturnValue(null);

    // When
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:2', method: 'chainSpec_v1_chainName', params: [] }));
    await responses.next();

    // Then
    expect(metrics.counted('truapi_chain.reopen')).toEqual([{ outcome: 'error', reason: 'no_transport' }]);
  });

  it('As an operator, I watch a re-lease that throws and it is captured and counted while the request is still answered', async () => {
    // Given
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const connection = await createProductConnect(sources, { destroyDelay: 0 })(fromHex(people));
    onTestFinished(() => {
      connection.close();
    });
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(sources.upstreams[0], 'upstream').halt();
    sources.createRemoteChain.mockImplementation(() => {
      throw new Error('transport refused');
    });

    // When
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:2', method: 'chainSpec_v1_chainName', params: [] }));
    const answer: unknown = JSON.parse(yielded(await responses.next()));

    // Then
    expect(answer).toMatchObject({ id: 'truapi:2', error: { data: 'dotli:chain-halted' } });
    expect(captures.exception).toHaveBeenCalledWith(expect.objectContaining({ message: 'transport refused' }), {
      flow: 'protocol',
      step: 'chain_reopen',
    });
    expect(metrics.counted('truapi_chain.reopen')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it("As a dotli integrator, I connect a core to a chain on a light client backend and it goes through the protocol frame's light client", async () => {
    // Given the shared worker light client backend the sources start on

    // When
    await createProductConnect(sources, { destroyDelay: 0 })(fromHex(people));

    // Then
    expect(sources.createRemoteChain).toHaveBeenCalledWith(people.toLowerCase());
    expect(sources.createRpcChain).not.toHaveBeenCalled();
  });

  it('As a dotli user on Trusted Providers, I connect a product to a chain and it goes through the core RPC transport', async () => {
    // Given
    sources.setBackend('rpc-gateway');

    // When
    await createProductConnect(sources, { destroyDelay: 0 })(fromHex(assetHub));

    // Then
    expect(sources.createRpcChain).toHaveBeenCalledWith(assetHub.toLowerCase(), expect.any(Object));
    expect(sources.createRemoteChain).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I connect two cores to one chain and they share one transport', async () => {
    // Given
    const connect = createProductConnect(sources, { destroyDelay: 0 });

    // When
    await connect(fromHex(people));
    await connect(fromHex(people));

    // Then
    expect(sources.upstreams).toHaveLength(1);
    expect(must(sources.upstreams[0], 'upstream').opened).toBe(1);
  });

  it('As a dotli integrator, I send one request id from two core connections and each gets only its own response', async () => {
    // Given
    const connect = createProductConnect(sources, { destroyDelay: 0 });
    const first = await connect(fromHex(people));
    const second = await connect(fromHex(people));
    onTestFinished(() => {
      first.close();
      second.close();
    });
    const firstResponses = first.responses()[Symbol.asyncIterator]();
    const secondResponses = second.responses()[Symbol.asyncIterator]();
    const request = { jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_genesisHash', params: [] };
    first.send(JSON.stringify(request));
    second.send(JSON.stringify(request));
    const upstream = must(sources.upstreams[0], 'upstream');
    const [toFirst, toSecond] = upstream.sent;

    // When
    upstream.emit({ jsonrpc: '2.0', id: must(must(toSecond, 'second request').id, 'id'), result: 'second' });
    upstream.emit({ jsonrpc: '2.0', id: must(must(toFirst, 'first request').id, 'id'), result: 'first' });
    const answers: unknown[] = [
      JSON.parse(yielded(await firstResponses.next())),
      JSON.parse(yielded(await secondResponses.next())),
    ];

    // Then
    expect(answers).toEqual([
      { jsonrpc: '2.0', id: 'truapi:1', result: 'first' },
      { jsonrpc: '2.0', id: 'truapi:1', result: 'second' },
    ]);
  });

  it('As a dotli integrator, I keep a core connection through a halted chain transport and its stream stays open', async () => {
    // Given
    const connection = await createProductConnect(sources, { destroyDelay: 0 })(fromHex(people));
    onTestFinished(() => {
      connection.close();
    });
    const responses = connection.responses()[Symbol.asyncIterator]();
    const pending = responses.next();

    // When
    must(sources.upstreams[0], 'upstream').halt();
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:2', method: 'chainSpec_v1_chainName', params: [] }));
    const rebuilt = must(sources.upstreams[1], 'rebuilt upstream');
    rebuilt.emit({ jsonrpc: '2.0', id: must(must(rebuilt.sent[0], 'request').id, 'id'), result: 'People' });
    const answer: unknown = JSON.parse(yielded(await pending));

    // Then
    expect(answer).toEqual({ jsonrpc: '2.0', id: 'truapi:2', result: 'People' });
  });

  it('As a dotli integrator, I take a lease that halts before it is handed over and it is not kept', async () => {
    // Given a pool whose first lease halts while it is being taken
    const live = { send: vi.fn<JsonRpcConnection['send']>(), disconnect: vi.fn<() => void>() };
    const dead = { send: vi.fn<JsonRpcConnection['send']>(), disconnect: vi.fn<() => void>() };
    let leases = 0;
    function provideLease(_onMessage: (message: JsonRpcMessage) => void, onHalt?: (error?: unknown) => void) {
      leases += 1;
      if (leases === 1) {
        onHalt?.(new Error('chain died while connecting'));
        return dead;
      }
      return live;
    }
    // The connect reaches only these two members of the pool.
    const pool = { getLocalProvider: () => provideLease, status: () => 'disconnected' } as unknown as ChainPool;
    const connection = await createChainConnect({ pool, frame: READY_FRAME, sources })(fromHex(people));

    // When
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_chainName', params: [] }));

    // Then the request went out on a new lease, not the dead one
    expect(dead.send).not.toHaveBeenCalled();
    expect(live.send).toHaveBeenCalledTimes(1);

    // When
    connection.close();

    // Then
    expect(live.disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, I send after a halt that no new transport can serve and the request is answered at once', async () => {
    // Given
    const connection = await createProductConnect(sources, { destroyDelay: 0 })(fromHex(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(sources.upstreams[0], 'upstream').halt();
    sources.createRemoteChain.mockReturnValue(null);

    // When a request and a notification go out
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:2', method: 'chainSpec_v1_chainName', params: [] }));
    connection.send(JSON.stringify({ jsonrpc: '2.0', method: 'chainSpec_v1_chainName', params: [] }));
    const answer: unknown = JSON.parse(yielded(await responses.next()));

    // Then the request gets the halted error, the notification nothing
    expect(answer).toEqual({ jsonrpc: '2.0', id: 'truapi:2', error: HALTED });

    // When
    connection.close();
    const afterTheClose = await responses.next();

    // Then
    expect(afterTheClose.done).toBe(true);
  });

  it('As a dotli integrator, I watch a chain transport halt and the messages queued before it are still delivered', async () => {
    // Given
    const connection = await createProductConnect(sources, { destroyDelay: 0 })(fromHex(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'truapi:1',
        method: 'transactionWatch_v1_submitAndWatch',
        params: ['0xdead'],
      }),
    );
    const upstream = must(sources.upstreams[0], 'upstream');
    upstream.emit({ jsonrpc: '2.0', id: must(must(upstream.sent[0], 'upstream submit').id, 'id'), result: 'watch-1' });

    // When the light client dies, and the frame reports the status and the halt in one step
    upstream.halt();
    const ack: unknown = JSON.parse(yielded(await responses.next()));
    const dropped: unknown = JSON.parse(yielded(await responses.next()));

    // Then
    expect([ack, dropped]).toEqual([
      expect.objectContaining({ id: 'truapi:1' }),
      {
        jsonrpc: '2.0',
        method: 'transactionWatch_v1_watchEvent',
        params: { subscription: readResult(ack), result: { event: 'dropped' } },
      },
    ]);

    // When
    connection.close();
    const afterTheClose = await responses.next();

    // Then
    expect(afterTheClose.done).toBe(true);
  });

  it('As a dotli integrator, I have a request in flight when the chain transport halts and it is answered', async () => {
    // Given
    const connection = await createProductConnect(sources, { destroyDelay: 0 })(fromHex(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    connection.send(
      JSON.stringify({ jsonrpc: '2.0', id: 'truapi:9', method: 'chainHead_v1_header', params: ['tok', '0xabc'] }),
    );
    const upstream = must(sources.upstreams[0], 'upstream');

    // When
    upstream.halt();
    const answer: unknown = JSON.parse(yielded(await responses.next()));

    // Then
    expect(upstream.sent).toHaveLength(1);
    expect(answer).toMatchObject({
      id: 'truapi:9',
      error: { message: 'Chain transport halted', data: 'dotli:chain-halted' },
    });

    // When
    connection.close();
    const afterTheClose = await responses.next();

    // Then
    expect(afterTheClose.done).toBe(true);
  });

  it('As a dotli integrator, I close a halted core connection twice and its lease is released once', async () => {
    // Given
    const pool = createHostChainPool({ ...sources, destroyDelay: 0 });
    const connection = await createChainConnect({ pool, frame: READY_FRAME, sources })(fromHex(people));
    const upstream = must(sources.upstreams[0], 'upstream');
    upstream.halt();

    // When
    connection.close();
    connection.close();

    // Then the transport is torn down once
    expect(upstream.disconnect).toHaveBeenCalledTimes(1);

    // When a new lease is taken
    await createChainConnect({ pool, frame: READY_FRAME, sources })(fromHex(people));

    // Then it builds a fresh transport and leaves the old one alone
    expect(sources.upstreams).toHaveLength(2);
    expect(upstream.disconnect).toHaveBeenCalledTimes(1);
  });

  describe('with the default pool settings', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Registered first, so it runs after every cleanup a test registers.
      onTestFinished(() => {
        vi.useRealTimers();
      });
    });

    it('As a dotli user on a light client backend, I close the last connection to a chain and the chain closes a minute later', async () => {
      // Given
      const connection = await createProductConnect(sources, {})(fromHex(people));
      const upstream = must(sources.upstreams[0], 'upstream');

      // When
      connection.close();
      await vi.advanceTimersByTimeAsync(59_999);
      const beforeAMinute = upstream.disconnect.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1);
      const atAMinute = upstream.disconnect.mock.calls.length;

      // Then
      expect([beforeAMinute, atAMinute]).toEqual([0, 1]);
    });

    it('As a dotli user on Trusted Providers, I close the last connection to an RPC chain and the chain closes', async () => {
      // Given
      sources.setBackend('rpc-gateway');
      const connection = await createProductConnect(sources, {})(fromHex(people));
      const upstream = must(sources.upstreams[0], 'upstream');

      // When
      connection.close();
      await vi.advanceTimersByTimeAsync(120_000);

      // Then
      expect(upstream.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  it('As a dotli integrator, I close a core connection twice and its lease is released once', async () => {
    // Given
    const connection = await createProductConnect(sources, { destroyDelay: 0 })(fromHex(people));

    // When
    connection.close();
    connection.close();

    // Then
    expect(must(sources.upstreams[0], 'upstream').disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, I connect to a chain the RPC backend cannot reach and it is refused before any transport is built', () => {
    // Given
    sources.setBackend('rpc-gateway');
    sources.isRpcChainSupported.mockReturnValue(false);

    // When
    const refusal = catchThrown(() => createProductConnect(sources, { destroyDelay: 0 })(fromHex(people)));

    // Then
    expect(refusal).toMatchObject({ message: `Unsupported RPC chain: ${people.toLowerCase()}` });
    expect(sources.createRpcChain).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I connect to a chain the protocol frame cannot serve and it is refused before any transport is built', () => {
    // Given
    sources.isRemoteChainConnectable.mockReturnValue(false);

    // When
    const refusal = catchThrown(() => createProductConnect(sources, { destroyDelay: 0 })(fromHex(people)));

    // Then
    expect(refusal).toMatchObject({ message: `Unsupported smoldot chain: ${people.toLowerCase()}` });
    expect(sources.createRemoteChain).not.toHaveBeenCalled();
  });
});

// The host page's chain pool end to end (Chain.ts, pool, broker, backend transport), with remote connections faked.

describe('host chain pool on a light client backend', () => {
  let people: string;
  let assetHub: string;
  let chains: FakeRemoteChains;

  beforeEach(() => {
    vi.useFakeTimers();
    // Registered first, so it runs after every cleanup a test registers.
    onTestFinished(() => {
      vi.useRealTimers();
    });
    onTestFinished(setSettings({ ...getSettings(), backend: 'smoldot-direct' }));
    people = getActiveServicesConfig().people.genesis;
    assetHub = getActiveServicesConfig().assethub.genesis;
    chains = createFakeRemoteChains();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['chain', 'frame'] as const)(
    "As a user, I keep a product's chain connection through a %s halt and what was queued arrives while its next request opens a fresh connection to the frame",
    async reason => {
      // Given a product request answered by the frame, not yet read
      const connection = await createChainConnect({
        pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain }),
        frame: chains.frame,
      })(fromHex(people));
      const responses = connection.responses()[Symbol.asyncIterator]();
      connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_chainName', params: [] }));
      const first = must(chains.remotes[0], 'first remote');
      first.emit({ jsonrpc: '2.0', id: must(must(first.sent[0], 'request').id, 'id'), result: 'People' });

      // When the connection to the frame halts, then the product asks again and the frame answers
      first.halt(reason);
      connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:2', method: 'chainSpec_v1_chainName', params: [] }));
      const queued: unknown = JSON.parse(yielded(await responses.next()));
      const remotesAfterTheHalt = chains.remotes.length;
      const second = must(chains.remotes[1], 'second remote');
      second.emit({ jsonrpc: '2.0', id: must(must(second.sent[0], 'request').id, 'id'), result: 'People again' });
      const reopened: unknown = JSON.parse(yielded(await responses.next()));

      // Then the queued answer arrives, and a new remote connection carries the next request to the same stream
      expect([queued, reopened]).toEqual([
        { jsonrpc: '2.0', id: 'truapi:1', result: 'People' },
        { jsonrpc: '2.0', id: 'truapi:2', result: 'People again' },
      ]);
      expect(remotesAfterTheHalt).toBe(2);
      expect(first.sent).toHaveLength(1);

      // When
      connection.close();
      const afterTheClose = await responses.next();

      // Then
      expect(afterTheClose.done).toBe(true);
    },
  );

  it('As a user whose chain halted with the frame, I ask while the frame is down and my requests wait on its boot instead of failing at once', async () => {
    // Given
    const connection = await createChainConnect({
      pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain }),
      frame: chains.frame,
    })(fromHex(people));
    onTestFinished(() => {
      connection.close();
    });
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(chains.remotes[0], 'first remote').halt('frame');
    chains.setFrameStatus('failed');

    // When the product asks, its papi client retries while the frame boots, and the booted frame answers
    askChainName(connection, 'truapi:1');
    for (let retry = 2; retry <= 5; retry++) {
      await vi.advanceTimersByTimeAsync(250);
      askChainName(connection, `truapi:${String(retry)}`);
    }
    const remotesWhileBooting = chains.remotes.length;
    const waiting = must(chains.remotes[1], 'People on the booting frame');
    const sentWhileBooting = waiting.sent.length;
    waiting.emit({ jsonrpc: '2.0', id: must(must(waiting.sent[0], 'request').id, 'id'), result: 'People' });
    const answer: unknown = JSON.parse(yielded(await responses.next()));

    // Then one new connection takes every request and waits on the boot, and the first answer comes once it is up
    expect(remotesWhileBooting).toBe(2);
    expect(sentWhileBooting).toBe(5);
    expect(answer).toEqual({ jsonrpc: '2.0', id: 'truapi:1', result: 'People' });
  });

  it('As a user whose frame fails every boot, I keep retrying and the frame is dialled at most once per gate window', async () => {
    // Given the frame died, and every boot of it fails at once
    const connection = await createChainConnect({
      pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain }),
      frame: chains.frame,
    })(fromHex(people));
    onTestFinished(() => {
      connection.close();
    });
    must(chains.remotes[0], 'first remote').halt('frame');
    chains.setFrameStatus('failed');
    chains.setRefusal('frame');

    // When the product's papi client retries every 250 ms for two minutes
    for (let retry = 0; retry < 480; retry++) {
      askChainName(connection, `truapi:${String(retry)}`);
      await vi.advanceTimersByTimeAsync(250);
    }

    // Then the frame is dialled at once, then at 1, 3, 7, 15, 31, 61 and 91 s, the gate's windows, and no more
    expect(chains.remotes).toHaveLength(9);
  });

  it('As a user, I ask again after a frame halt that finds no transport and the request is answered at once', async () => {
    // Given a frame halt, the frame back, and no transport to be had
    const connection = await createChainConnect({
      pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain }),
      frame: chains.frame,
    })(fromHex(people));
    onTestFinished(() => {
      connection.close();
    });
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(chains.remotes[0], 'first remote').halt('frame');
    chains.createRemoteChain.mockReturnValue(null);

    // When
    askChainName(connection, 'truapi:1');
    const answer: unknown = JSON.parse(yielded(await responses.next()));

    // Then
    expect(answer).toEqual({ jsonrpc: '2.0', id: 'truapi:1', error: HALTED });
    expect(chains.createRemoteChain).toHaveBeenCalledTimes(2);
  });

  it('As a user on a chain that halts right after each rebuild, I keep retrying and it is rebuilt only as the backoff allows', async () => {
    // Given the chain halted, and every rebuild of it halts at once
    const connection = await createChainConnect({
      pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain }),
      frame: chains.frame,
    })(fromHex(people));
    onTestFinished(() => {
      connection.close();
    });
    must(chains.remotes[0], 'first remote').halt('chain');
    chains.setRefusal('chain');

    // When the product's papi client retries every 250 ms for two minutes
    for (let retry = 0; retry < 480; retry++) {
      askChainName(connection, `truapi:${String(retry)}`);
      await vi.advanceTimersByTimeAsync(250);
    }

    // Then the chain is rebuilt at once, then at 1, 3, 7, 15, 31, 61 and
    // 91 s, the chain backoff's windows, and no more
    expect(chains.remotes).toHaveLength(9);
  });

  it('As a user, I ask on a chain whose backoff is shut and the request is answered at once', async () => {
    // Given the chain halted, was rebuilt at once, and halted again
    const connection = await createChainConnect({
      pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain }),
      frame: chains.frame,
    })(fromHex(people));
    onTestFinished(() => {
      connection.close();
    });
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(chains.remotes[0], 'first remote').halt('chain');
    askChainName(connection, 'truapi:1');
    must(chains.remotes[1], 'second remote').halt('chain');

    // When a request and a notification go out
    askChainName(connection, 'truapi:2');
    connection.send(JSON.stringify({ jsonrpc: '2.0', method: 'chainSpec_v1_chainName', params: [] }));
    const answers: unknown[] = [
      JSON.parse(yielded(await responses.next())),
      JSON.parse(yielded(await responses.next())),
    ];

    // Then each request gets the halted error, the notification nothing, and the chain is not rebuilt
    expect(answers).toEqual([
      { jsonrpc: '2.0', id: 'truapi:1', error: HALTED },
      { jsonrpc: '2.0', id: 'truapi:2', error: HALTED },
    ]);
    expect(chains.remotes).toHaveLength(2);
  });

  it('As a user, I see a chain halt again within 30 s of its rebuild and it is rebuilt 1 s later', async () => {
    // Given the chain halted, was rebuilt at once, and the rebuild lived 10 s
    const connection = await createChainConnect({
      pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain }),
      frame: chains.frame,
    })(fromHex(people));
    onTestFinished(() => {
      connection.close();
    });
    must(chains.remotes[0], 'first remote').halt('chain');
    askChainName(connection, 'truapi:1');
    await vi.advanceTimersByTimeAsync(10_000);

    // When the rebuild halts, and the product keeps asking
    must(chains.remotes[1], 'second remote').halt('chain');
    askChainName(connection, 'truapi:2');
    await vi.advanceTimersByTimeAsync(999);
    askChainName(connection, 'truapi:3');
    const beforeASecond = chains.remotes.length;
    await vi.advanceTimersByTimeAsync(1);
    askChainName(connection, 'truapi:4');
    const atASecond = chains.remotes.length;

    // Then
    expect([beforeASecond, atASecond]).toEqual([2, 3]);
  });

  it('As a user, I see a chain halt after its rebuild lived past 30 s and it is rebuilt at once', async () => {
    // Given the chain halted twice in a row, so its backoff has grown, and
    // the rebuild after that lived 31 s
    const connection = await createChainConnect({
      pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain }),
      frame: chains.frame,
    })(fromHex(people));
    onTestFinished(() => {
      connection.close();
    });
    must(chains.remotes[0], 'first remote').halt('chain');
    askChainName(connection, 'truapi:1');
    must(chains.remotes[1], 'second remote').halt('chain');
    await vi.advanceTimersByTimeAsync(1_000);
    askChainName(connection, 'truapi:2');
    await vi.advanceTimersByTimeAsync(31_000);

    // When it halts, and its rebuild halts right away while the product keeps asking
    must(chains.remotes[2], 'third remote').halt('chain');
    askChainName(connection, 'truapi:3');
    const afterTheHalt = chains.remotes.length;
    must(chains.remotes[3], 'fourth remote').halt('chain');
    await vi.advanceTimersByTimeAsync(999);
    askChainName(connection, 'truapi:4');
    const beforeASecond = chains.remotes.length;
    await vi.advanceTimersByTimeAsync(1);
    askChainName(connection, 'truapi:5');
    const atASecond = chains.remotes.length;

    // Then it is rebuilt at once, and a halt right after waits 1 s again
    expect([afterTheHalt, beforeASecond, atASecond]).toEqual([4, 4, 5]);
  });

  it("As a user, I wait out one chain's backoff and it does not hold back another chain", async () => {
    // Given People halted, was rebuilt at once, and halted again
    const connect = createChainConnect({
      pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain }),
      frame: chains.frame,
    });
    const onPeople = await connect(fromHex(people));
    const onAssetHub = await connect(fromHex(assetHub));
    onTestFinished(() => {
      onPeople.close();
      onAssetHub.close();
    });
    const peopleRemotes = (): RemoteConnection[] => chains.remotes.filter(r => r.genesisHash === people.toLowerCase());
    const assetHubRemotes = (): RemoteConnection[] =>
      chains.remotes.filter(r => r.genesisHash === assetHub.toLowerCase());
    must(peopleRemotes()[0], 'People').halt('chain');
    askChainName(onPeople, 'p:1');
    must(peopleRemotes()[1], 'rebuilt People').halt('chain');

    // When Asset Hub halts, and both products ask
    must(assetHubRemotes()[0], 'Asset Hub').halt('chain');
    askChainName(onAssetHub, 'a:1');
    askChainName(onPeople, 'p:2');

    // Then Asset Hub is rebuilt at once, People waits for its own window
    expect(assetHubRemotes()).toHaveLength(2);
    expect(peopleRemotes()).toHaveLength(2);
  });

  it('As a user with two products on a halted chain, I let both ask and they share its rebuild and wait together when it halts again', async () => {
    // Given
    const connect = createChainConnect({
      pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain }),
      frame: chains.frame,
    });
    const first = await connect(fromHex(people));
    const second = await connect(fromHex(people));
    onTestFinished(() => {
      first.close();
      second.close();
    });
    must(chains.remotes[0], 'first remote').halt('chain');

    // When both products ask
    askChainName(first, 'a:1');
    askChainName(second, 'b:1');

    // Then the first rebuilt the chain, and the second's request rides on it
    expect(chains.remotes).toHaveLength(2);
    expect(must(chains.remotes[1], 'second remote').sent).toHaveLength(2);

    // When the rebuild halts at once, both ask again, and both ask once more after the window opens
    must(chains.remotes[1], 'second remote').halt('chain');
    askChainName(first, 'a:2');
    askChainName(second, 'b:2');
    const beforeTheWindow = chains.remotes.length;
    await vi.advanceTimersByTimeAsync(1_000);
    askChainName(second, 'b:3');
    askChainName(first, 'a:3');

    // Then neither rebuilds it before the window opens, and one rebuild then carries both
    expect([beforeTheWindow, chains.remotes.length]).toEqual([2, 3]);
    expect(must(chains.remotes[2], 'third remote').sent).toHaveLength(2);
  });

  it('As a user, I release the last of two leases and the connection to the protocol frame closes 60 seconds later', async () => {
    // Given
    const connect = createChainConnect({
      pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain }),
      frame: chains.frame,
    });
    const first = await connect(fromHex(people));
    const second = await connect(fromHex(people));
    const remote = must(chains.remotes[0], 'remote');

    // When one lease is released, and the other a while later
    first.close();
    await vi.advanceTimersByTimeAsync(30_000);
    second.close();
    await vi.advanceTimersByTimeAsync(59_999);
    const beforeAMinute = remote.disconnect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    const atAMinute = remote.disconnect.mock.calls.length;

    // Then the countdown started at the second release
    expect([beforeAMinute, atAMinute]).toEqual([0, 1]);
  });
});

// End to end through the real host path (the chain connect, the chain pool and broker, the replaying RPC transport)
// over a fake server.

describe('host chain connection over Trusted Providers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Registered first, so it runs after every cleanup a test registers.
    onTestFinished(() => {
      vi.useRealTimers();
    });
    FakeWebSocket.instances = [];
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
  });

  it('As a chat user on Trusted Providers, I keep a statement subscription through 120 seconds of quiet and it keeps delivering', async () => {
    // Given a core connection to the People chain and an acknowledged subscription
    const people = getActiveServicesConfig().people.genesis;
    const connection = await createChainConnect({
      pool: createHostChainPool({ destroyDelay: 0, createRpcChain: createFakeSocketChain }),
    })(fromHex(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    const readResponse = async (): Promise<unknown> => JSON.parse(yielded(await responses.next()));
    connection.send(
      JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'statement_subscribeStatement', params: FILTER }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const first = must(FakeWebSocket.instances[0], 'first socket');
    first.open();
    const subscribe = must(first.requests('statement_subscribeStatement')[0], 'subscribe');
    first.deliver({ jsonrpc: '2.0', id: subscribe.id, result: 'srv-1' });
    const ack = await readResponse();
    first.deliver(buildStatement('srv-1', '0x01'));
    await vi.advanceTimersByTimeAsync(1_000);
    first.deliver(buildStatement('srv-1', '0x02'));
    const early = [await readResponse(), await readResponse()];

    // When 120 seconds pass with no traffic, and the heartbeat replaces the socket
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const second = must(FakeWebSocket.instances[1], 'second socket');
    second.open();
    const resubscribe = must(second.requests('statement_subscribeStatement')[0], 'resubscribe');
    second.deliver({ jsonrpc: '2.0', id: resubscribe.id, result: 'srv-2' });
    second.deliver(buildStatement('srv-2', '0x03'));
    const late = await readResponse();
    const subscription = readResult(ack);

    // Then the product keeps its subscription id across both sockets
    expect([ack, ...early, late]).toMatchObject([
      { id: 'truapi:1' },
      { params: { subscription, result: { data: { statements: ['0x01'] } } } },
      { params: { subscription, result: { data: { statements: ['0x02'] } } } },
      { params: { subscription, result: { data: { statements: ['0x03'] } } } },
    ]);
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(second.requests('statement_subscribeStatement')).toHaveLength(1);

    // When the core cancels
    connection.close();

    // Then the live server subscription is released and the socket closed
    expect(second.requests('statement_unsubscribeStatement').map((request): unknown => request.params)).toEqual([
      ['srv-2'],
    ]);
    expect(second.readyState).toBe(FakeWebSocket.CLOSED);
  });
});

/** A product's chain connect on its own page pool, over a frame that is always ready. */
function createProductConnect(
  sources: FakeHostChainSources,
  { destroyDelay }: Params,
): ReturnType<typeof createChainConnect> {
  const pool = createHostChainPool({ ...sources, ...(destroyDelay === undefined ? {} : { destroyDelay }) });
  return createChainConnect({ pool, frame: READY_FRAME, sources });
}

/** Asks the chain for its name over `connection` under the request id `id`. */
function askChainName(connection: { send: (request: string) => void }, id: string): void {
  connection.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'chainSpec_v1_chainName', params: [] }));
}

/** What `run` threw, or undefined when it returned. */
function catchThrown(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The `result` of a JSON-RPC answer, or undefined for anything else. */
function readResult(message: unknown): unknown {
  return isRecord(message) ? message['result'] : undefined;
}

function buildStatement(subscription: string, encoded: string): unknown {
  return {
    jsonrpc: '2.0',
    method: 'statement_statement',
    params: { subscription, result: { event: 'newStatements', data: { statements: [encoded], remaining: 0 } } },
  };
}
