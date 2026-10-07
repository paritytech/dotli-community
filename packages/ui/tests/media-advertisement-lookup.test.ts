// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client answers a statement subscription with no stored statements,
// so a Media advertisement lookup there finds no callee endpoint. Through the
// real host path (Chain.ts, the chain pools and broker, the replaying RPC
// transport) the core's marked lookups go to the trusted RPC node instead.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, setBackend } from '@dotli/config';
import type * as ClientModule from '../../protocol/src/client.js';
import { FakeWebSocket } from '../../resolver/tests/fake-websocket.js';
import { createChainConnect, createHostChainPool } from '../src/host-callbacks/Chain.js';
import { hexBytes, must, yielded } from './support.js';
import { VOX_PASEO_LOBBY_TOPIC } from '../src/host-callbacks/vox-presence-snapshot.js';

const ADVERTISEMENT = '0xad';
const FILTER = [{ matchAll: [`0x${'ab'.repeat(32)}`] }];
const LOOKUP_ID = 'truapi:media-advertisement-lookup:1';
const PRESENCE = '0xbe';

const mocks = vi.hoisted(() => ({
  lightClient: [] as JsonRpcRequest[],
}));

/** A light client: every statement subscription's snapshot is empty. */
function lightClientTransport(): (onMessage: (message: JsonRpcMessage) => void) => JsonRpcConnection {
  return onMessage => ({
    send(message) {
      const request = message as JsonRpcRequest;
      mocks.lightClient.push(request);
      if (request.method === 'statement_subscribeStatement') {
        onMessage({ jsonrpc: '2.0', id: request.id, result: 'light-1' } as JsonRpcMessage);
        onMessage({
          jsonrpc: '2.0',
          method: 'statement_statement',
          params: {
            subscription: 'light-1',
            result: { event: 'newStatements', data: { statements: [], remaining: 0 } },
          },
        } as JsonRpcMessage);
      }
    },
    disconnect() {},
  });
}

vi.mock('../src/host-callbacks/frame-transport.js', () => ({
  createFrameChainTransport: lightClientTransport,
}));

vi.mock('../../protocol/src/client.js', async importOriginal => ({
  ...(await importOriginal<typeof ClientModule>()),
  isRemoteChainConnectable: () => true,
}));

interface Notification {
  params: { subscription: string; result: { data: { statements: string[] } } };
}

describe('Media advertisement lookups on a light client backend', () => {
  const people = getActiveServicesConfig().people.genesis;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    FakeWebSocket.instances = [];
    mocks.lightClient = [];
    setBackend('smoldot-direct');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("As a caller on the light client, the host finds the callee's advertisement on the trusted RPC node", async () => {
    // Given: the core's lookup connection to the People chain.
    const connection = await createChainConnect(createHostChainPool(0))(hexBytes(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    const next = async (): Promise<unknown> => JSON.parse(yielded(await responses.next())) as unknown;

    // When: the core subscribes for the snapshot and the trusted node holds the advertisement.
    connection.send(
      JSON.stringify({ jsonrpc: '2.0', id: LOOKUP_ID, method: 'statement_subscribeStatement', params: FILTER }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const trusted = must(FakeWebSocket.instances[0], 'trusted RPC socket');
    trusted.open();
    const subscribe = must(trusted.requests('statement_subscribeStatement')[0], 'subscribe');
    trusted.deliver({ jsonrpc: '2.0', id: subscribe.id, result: 'srv-1' });
    trusted.deliver({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: 'srv-1',
        result: { event: 'newStatements', data: { statements: [ADVERTISEMENT], remaining: 0 } },
      },
    });
    const ack = (await next()) as { id: string; result: string };
    const snapshot = (await next()) as Notification;

    // Then: the snapshot carries the advertisement, and the light client saw no lookup.
    expect(ack.id).toBe(LOOKUP_ID);
    expect(subscribe.params).toEqual(FILTER);
    expect(snapshot.params.subscription).toBe(ack.result);
    expect(snapshot.params.result.data.statements).toEqual([ADVERTISEMENT]);
    expect(mocks.lightClient).toEqual([]);

    // When: the core ends the lookup.
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'truapi:media-advertisement-lookup:2',
        method: 'statement_unsubscribeStatement',
        params: [ack.result],
      }),
    );
    connection.close();

    // Then: the trusted subscription is released and its socket closed.
    expect(trusted.requests('statement_unsubscribeStatement').map((request): unknown => request.params)).toEqual([
      ['srv-1'],
    ]);
    expect(trusted.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('As a newly opened Vox device, the host reads the retained public presence snapshot from the trusted node', async () => {
    // Given: Vox subscribes to its one exact public lobby topic.
    const connection = await createChainConnect(createHostChainPool(0))(hexBytes(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    const next = async (): Promise<unknown> => JSON.parse(yielded(await responses.next())) as unknown;
    const filter = [{ matchAll: [VOX_PASEO_LOBBY_TOPIC] }];

    // When: the trusted node already holds another device's presence note.
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'truapi:presence:1',
        method: 'statement_subscribeStatement',
        params: filter,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const trusted = must(FakeWebSocket.instances[0], 'trusted RPC socket');
    trusted.open();
    const subscribe = must(trusted.requests('statement_subscribeStatement')[0], 'subscribe');
    trusted.deliver({ jsonrpc: '2.0', id: subscribe.id, result: 'vox-presence-1' });
    trusted.deliver({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: 'vox-presence-1',
        result: { event: 'newStatements', data: { statements: [PRESENCE], remaining: 0 } },
      },
    });
    const ack = (await next()) as { id: string; result: string };
    const snapshot = (await next()) as Notification;

    // Then: the retained note reaches Vox without exposing any other product subscription to RPC.
    expect(ack.id).toBe('truapi:presence:1');
    expect(subscribe.params).toEqual(filter);
    expect(snapshot.params.subscription).toBe(ack.result);
    expect(snapshot.params.result.data.statements).toEqual([PRESENCE]);
    expect(mocks.lightClient).toEqual([]);

    // And: only this trusted subscription's stop follows it to the node.
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'truapi:presence:2',
        method: 'statement_unsubscribeStatement',
        params: [ack.result],
      }),
    );
    expect(trusted.requests('statement_unsubscribeStatement').map((request): unknown => request.params)).toEqual([
      ['vox-presence-1'],
    ]);
    connection.close();
  });

  it('keeps broader filters containing the Vox topic on the light client', async () => {
    // Given
    const connection = await createChainConnect(createHostChainPool(0))(hexBytes(people));

    // When: a product requests the topic through a broader or different filter.
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'truapi:1',
        method: 'statement_subscribeStatement',
        params: [{ matchAny: [VOX_PASEO_LOBBY_TOPIC] }],
      }),
    );
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'truapi:2',
        method: 'statement_subscribeStatement',
        params: [{ matchAll: [VOX_PASEO_LOBBY_TOPIC, `0x${'ef'.repeat(32)}`] }],
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Then: exact matching cannot expand what the trusted node observes.
    expect(mocks.lightClient.map(request => request.method)).toEqual([
      'statement_subscribeStatement',
      'statement_subscribeStatement',
    ]);
    expect(FakeWebSocket.instances).toEqual([]);
    connection.close();
  });

  it('As a chat user on the light client, other statement traffic stays on the light client', async () => {
    // Given
    const connection = await createChainConnect(createHostChainPool(0))(hexBytes(people));

    // When: an unmarked subscription, and a marked request that is not a lookup.
    connection.send(
      JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'statement_subscribeStatement', params: FILTER }),
    );
    connection.send(
      JSON.stringify({ jsonrpc: '2.0', id: `${LOOKUP_ID}0`, method: 'statement_submit', params: ['0x01'] }),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(mocks.lightClient.map(request => request.method)).toEqual([
      'statement_subscribeStatement',
      'statement_submit',
    ]);
    expect(FakeWebSocket.instances).toEqual([]);
    connection.close();
  });

  it('As a dotli user on Trusted Providers, a lookup uses the one RPC connection', async () => {
    // Given
    setBackend('rpc-gateway');
    const connection = await createChainConnect(createHostChainPool(0))(hexBytes(people));

    // When
    connection.send(
      JSON.stringify({ jsonrpc: '2.0', id: LOOKUP_ID, method: 'statement_subscribeStatement', params: FILTER }),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(mocks.lightClient).toEqual([]);
    connection.close();
  });
});
