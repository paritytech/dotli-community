// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { getActiveServicesConfig, getSettings, setSettings } from '@dotli/config';
import { FakeWebSocket } from '@dotli/chains/testing';
import { fromHex, isRecord } from '@dotli/shared';
import { must } from '@dotli/shared/testing';
import {
  createFakeHostChainSources,
  createFakeRemoteChains,
  createFakeSocketChain,
  type FakeHostChainSources,
  type FakeRemoteChains,
} from './createHostChainPool.fake.js';
import { createChainConnect } from './createChainConnect.js';
import { ERRORS } from '../errors.js';
import { createHostChainPool, type FrameStatusSource } from './createHostChainPool.js';
import { yielded } from '../../testing/fixtures.js';

type Params = {
  /** How long an idle chain stays open. Unset, the pool's default minute. */
  destroyDelay?: number;
};

const READY_FRAME: FrameStatusSource = { getProtocolStatus: () => 'ready' };

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

  it('As a product, I send a chain request that is not JSON and it is refused as an invalid JSON-RPC request', async () => {
    // Given
    const connection = await createProductConnect(sources, { destroyDelay: 0 })(fromHex(people));

    // When
    const refusal = catchThrown(() => {
      connection.send('not json');
    });

    // Then
    expect(refusal).toMatchObject({ message: ERRORS.INVALID_JSON_RPC_REQUEST });
    expect(refusal).toHaveProperty('cause', expect.any(SyntaxError));
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
  let chains: FakeRemoteChains;

  beforeEach(() => {
    vi.useFakeTimers();
    // Registered first, so it runs after every cleanup a test registers.
    onTestFinished(() => {
      vi.useRealTimers();
    });
    onTestFinished(setSettings({ ...getSettings(), backend: 'smoldot-direct' }));
    people = getActiveServicesConfig().people.genesis;
    chains = createFakeRemoteChains();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['chain', 'frame'] as const)(
    "As a user, I keep a product's chain connection through a %s halt and what was queued arrives while its next request goes on the rebuilt connection to the frame",
    async reason => {
      // Given a product request answered by the frame, not yet read
      const connection = await createChainConnect({
        pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain, frame: chains.frame }),
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
      pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain, frame: chains.frame }),
    })(fromHex(people));
    onTestFinished(() => {
      connection.close();
    });
    const responses = connection.responses()[Symbol.asyncIterator]();
    chains.setFrameStatus('failed');
    must(chains.remotes[0], 'first remote').halt('frame');

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
  const pool = createHostChainPool({
    ...sources,
    frame: READY_FRAME,
    ...(destroyDelay === undefined ? {} : { destroyDelay }),
  });
  return createChainConnect({ pool, sources });
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
