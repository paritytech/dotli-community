// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, type Mock } from 'vitest';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { createChainBrokerManager } from '../src/broker.js';

interface ProviderHarness {
  provider: JsonRpcProvider;
  sent: JsonRpcRequest[];
  disconnect: Mock;
  emit: (message: JsonRpcMessage) => void;
}

function createProviderHarness(): ProviderHarness {
  const sent: JsonRpcRequest[] = [];
  const disconnect = vi.fn();
  let onMessage: ((message: JsonRpcMessage) => void) | null = null;

  const provider: JsonRpcProvider = (listener): JsonRpcConnection => {
    onMessage = listener;
    return {
      send(message) {
        sent.push(message);
      },
      disconnect,
    };
  };

  return {
    provider,
    sent,
    disconnect,
    emit(message) {
      onMessage?.(message);
    },
  };
}

function subscriptionToken(message: unknown): string {
  const parsed: unknown = typeof message === 'string' ? JSON.parse(message) : message;
  if (typeof parsed !== 'object' || parsed === null || !('result' in parsed) || typeof parsed.result !== 'string') {
    throw new Error('Expected a subscription token response');
  }
  return parsed.result;
}

function requestId(request: JsonRpcRequest | undefined): string | number | null {
  if (request?.id === undefined) {
    throw new Error('Expected an upstream request with an ID');
  }
  return request.id;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Expected a recorded provider event');
  }
  return value;
}

describe('createChainBrokerManager', () => {
  it('rewrites subscription tokens per client and routes follow events', () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', message => {
      messagesA.push(message);
    });
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', message => {
      messagesB.push(message);
    });

    connectionA?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'chainHead_v1_follow',
        params: [true],
      }),
    );
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'chainHead_v1_follow',
        params: [true],
      }),
    );

    expect(harness.sent).toHaveLength(1);
    const upstream = harness.sent[0] as { id: string };
    harness.emit({ jsonrpc: '2.0', id: upstream.id, result: 'up-a' });

    const localTokenA = (JSON.parse(messagesA[0] ?? '{}') as { result: string }).result;
    const localTokenB = (JSON.parse(messagesB[0] ?? '{}') as { result: string }).result;
    expect(localTokenA).not.toBe(localTokenB);

    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: 'up-a', result: { event: 'bestBlockChanged' } },
    });

    expect(messagesA[1]).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: {
          subscription: localTokenA,
          result: { event: 'bestBlockChanged' },
        },
      }),
    );
    expect(messagesB[1]).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: {
          subscription: localTokenB,
          result: { event: 'bestBlockChanged' },
        },
      }),
    );
  });

  it('releases owned subscriptions on disconnect but keeps the upstream warm until disconnectAll', () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const connection = manager.connectRemote('asset-hub', 'conn-a', () => {});

    connection?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'chainHead_v1_follow',
        params: [true],
      }),
    );

    const upstreamRequest = harness.sent[0] as { id: string };
    harness.emit({ jsonrpc: '2.0', id: upstreamRequest.id, result: 'up-a' });

    connection?.disconnect();

    const release = harness.sent[1] as { method: string; params: string[] };
    expect(release.method).toBe('chainHead_v1_unfollow');
    expect(release.params[0]).toBe('up-a');
    expect(harness.disconnect).not.toHaveBeenCalled();

    manager.disconnectAll();
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
  });

  it('routes legacy extrinsic updates only to their owner and releases the watch', () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('people', 'sender', message => messagesA.push(message));
    manager.connectRemote('people', 'receiver', message => messagesB.push(message));
    connectionA?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'author_submitAndWatchExtrinsic',
        params: ['0x0102'],
      }),
    );
    const upstream = harness.sent[0];
    if (upstream?.id === undefined) {
      throw new Error('Expected the upstream watch request');
    }
    harness.emit({
      jsonrpc: '2.0',
      method: 'author_extrinsicUpdate',
      params: { subscription: 'up-legacy', result: 'ready' },
    });
    harness.emit({ jsonrpc: '2.0', id: upstream.id, result: 'up-legacy' });
    const response: unknown = JSON.parse(messagesA[0] ?? '{}');
    if (
      response === null ||
      typeof response !== 'object' ||
      !('result' in response) ||
      typeof response.result !== 'string'
    ) {
      throw new Error('Expected a subscription token');
    }
    const localToken = response.result;
    harness.emit({
      jsonrpc: '2.0',
      method: 'author_extrinsicUpdate',
      params: { subscription: 'up-legacy', result: { inBlock: '0xabc' } },
    });
    expect(messagesA.slice(1).map((message): unknown => JSON.parse(message))).toEqual([
      {
        jsonrpc: '2.0',
        method: 'author_extrinsicUpdate',
        params: { subscription: localToken, result: 'ready' },
      },
      {
        jsonrpc: '2.0',
        method: 'author_extrinsicUpdate',
        params: { subscription: localToken, result: { inBlock: '0xabc' } },
      },
    ]);
    expect(messagesB).toEqual([]);
    connectionA?.disconnect();
    expect(harness.sent[1]).toMatchObject({
      method: 'author_unwatchExtrinsic',
      params: ['up-legacy'],
    });
    manager.disconnectAll();
  });

  it('releases transactionWatch subscriptions on disconnect', () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const connection = manager.connectRemote('asset-hub', 'conn-a', () => {});

    connection?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionWatch_v1_submitAndWatch',
        params: ['0x0102'],
      }),
    );

    const upstreamRequest = harness.sent[0] as { id: string; method: string };
    expect(upstreamRequest.method).toBe('transactionWatch_v1_submitAndWatch');
    harness.emit({ jsonrpc: '2.0', id: upstreamRequest.id, result: 'up-tx' });

    connection?.disconnect();

    const release = harness.sent[1] as { method: string; params: string[] };
    expect(release.method).toBe('transactionWatch_v1_unwatch');
    expect(release.params[0]).toBe('up-tx');
  });

  it('delivers transactionWatch events received before the subscribe response', () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const messages: string[] = [];
    const connection = manager.connectRemote('asset-hub', 'conn-a', message => messages.push(message));

    connection?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionWatch_v1_submitAndWatch',
        params: ['0x0102'],
      }),
    );

    const upstreamRequest = harness.sent[0] as { id: string };
    harness.emit({
      jsonrpc: '2.0',
      method: 'transactionWatch_v1_watchEvent',
      params: {
        subscription: 'up-tx',
        result: { event: 'finalized', block: { hash: '0xabc' } },
      },
    });
    expect(messages).toEqual([]);

    harness.emit({
      jsonrpc: '2.0',
      id: upstreamRequest.id,
      result: 'up-tx',
    });

    const response = JSON.parse(messages[0] ?? '{}') as { result: string };
    expect(JSON.parse(messages[1] ?? '{}')).toEqual({
      jsonrpc: '2.0',
      method: 'transactionWatch_v1_watchEvent',
      params: {
        subscription: response.result,
        result: { event: 'finalized', block: { hash: '0xabc' } },
      },
    });
  });

  it('routes legacy author_submitAndWatchExtrinsic updates and unwatch', () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const messages: string[] = [];
    const connection = manager.connectRemote('people', 'conn-a', message => messages.push(message));

    connection?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'author_submitAndWatchExtrinsic',
        params: ['0x0102'],
      }),
    );
    const upstreamRequest = harness.sent[0] as { id: string };
    harness.emit({ jsonrpc: '2.0', id: upstreamRequest.id, result: 'up-ext' });
    const response = JSON.parse(messages[0] ?? '{}') as { result: string };
    const localToken = response.result;

    harness.emit({
      jsonrpc: '2.0',
      method: 'author_extrinsicUpdate',
      params: { subscription: 'up-ext', result: { inBlock: '0xabc' } },
    });
    expect(JSON.parse(messages[1] ?? '{}')).toEqual({
      jsonrpc: '2.0',
      method: 'author_extrinsicUpdate',
      params: { subscription: localToken, result: { inBlock: '0xabc' } },
    });

    connection?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'author_unwatchExtrinsic',
        params: [localToken],
      }),
    );
    const release = harness.sent[1] as { method: string; params: string[] };
    expect(release.method).toBe('author_unwatchExtrinsic');
    expect(release.params[0]).toBe('up-ext');
  });

  it('fans out same-token statement notifications to every local owner', () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', m => messagesA.push(m));
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', m => messagesB.push(m));

    connectionA?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'statement_subscribeStatement',
        params: [{ matchAll: ['0xtopic'] }],
      }),
    );
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'statement_subscribeStatement',
        params: [{ matchAll: ['0xtopic'] }],
      }),
    );

    harness.emit({
      jsonrpc: '2.0',
      id: (harness.sent[0] as { id: string }).id,
      result: 'up-stmt',
    });
    harness.emit({
      jsonrpc: '2.0',
      id: (harness.sent[1] as { id: string }).id,
      result: 'up-stmt',
    });

    const localTokenA = (JSON.parse(messagesA[0] ?? '{}') as { result: string }).result;
    const localTokenB = (JSON.parse(messagesB[0] ?? '{}') as { result: string }).result;
    expect(localTokenA).not.toBe(localTokenB);

    harness.emit({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: 'up-stmt',
        result: { event: 'newStatements', data: { statements: [] } },
      },
    });

    expect(messagesA[1]).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'statement_statement',
        params: {
          subscription: localTokenA,
          result: { event: 'newStatements', data: { statements: [] } },
        },
      }),
    );
    expect(messagesB[1]).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'statement_statement',
        params: {
          subscription: localTokenB,
          result: { event: 'newStatements', data: { statements: [] } },
        },
      }),
    );

    connectionA?.disconnect();
    expect(harness.sent.filter(message => message.method === 'statement_unsubscribeStatement')).toHaveLength(0);

    connectionB?.disconnect();
    const releases = harness.sent.filter(message => message.method === 'statement_unsubscribeStatement');
    expect(releases).toHaveLength(1);
    expect((releases[0]?.params as unknown[])[0]).toBe('up-stmt');
  });

  it('ref-counts same-token statement unsubscribe requests', () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', m => messagesA.push(m));
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', m => messagesB.push(m));

    connectionA?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'statement_subscribeStatement',
        params: [{ matchAll: ['0xtopic'] }],
      }),
    );
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'statement_subscribeStatement',
        params: [{ matchAll: ['0xtopic'] }],
      }),
    );
    harness.emit({
      jsonrpc: '2.0',
      id: (harness.sent[0] as { id: string }).id,
      result: 'up-stmt',
    });
    harness.emit({
      jsonrpc: '2.0',
      id: (harness.sent[1] as { id: string }).id,
      result: 'up-stmt',
    });
    const localTokenA = (JSON.parse(messagesA[0] ?? '{}') as { result: string }).result;
    const localTokenB = (JSON.parse(messagesB[0] ?? '{}') as { result: string }).result;

    connectionA?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'statement_unsubscribeStatement',
        params: [localTokenA],
      }),
    );
    expect(JSON.parse(messagesA.at(-1) ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 10,
      result: true,
    });
    expect(harness.sent.filter(message => message.method === 'statement_unsubscribeStatement')).toHaveLength(0);

    harness.emit({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: 'up-stmt',
        result: { event: 'newStatements', data: { statements: [] } },
      },
    });
    expect(messagesA).toHaveLength(2);
    expect(messagesB.at(-1)).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'statement_statement',
        params: {
          subscription: localTokenB,
          result: { event: 'newStatements', data: { statements: [] } },
        },
      }),
    );

    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'statement_unsubscribeStatement',
        params: [localTokenB],
      }),
    );
    const release = harness.sent.at(-1) as {
      id: string;
      method: string;
      params: string[];
    };
    expect(release.method).toBe('statement_unsubscribeStatement');
    expect(release.params[0]).toBe('up-stmt');

    harness.emit({
      jsonrpc: '2.0',
      id: release.id,
      result: true,
    } as JsonRpcMessage);
    expect(JSON.parse(messagesB.at(-1) ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 11,
      result: true,
    });
  });

  it('reuses the warm upstream when a new session attaches after every previous one disconnected', () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);

    const connectionA = manager.connectRemote('asset-hub', 'conn-a', () => {});
    connectionA?.disconnect();
    expect(harness.disconnect).not.toHaveBeenCalled();

    const connectionB = manager.connectRemote('asset-hub', 'conn-b', () => {});
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'chainSpec_v1_chainName',
        params: [],
      }),
    );
    expect(harness.sent.at(-1)).toMatchObject({
      method: 'chainSpec_v1_chainName',
    });
    expect(harness.disconnect).not.toHaveBeenCalled();

    manager.disconnectAll();
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
  });

  it('replays a coherent cached follow snapshot to later subscribers', () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', message => {
      messagesA.push(message);
    });
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', message => {
      messagesB.push(message);
    });

    connectionA?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'chainHead_v1_follow',
        params: [true],
      }),
    );

    const upstream = harness.sent[0] as { id: string };
    harness.emit({ jsonrpc: '2.0', id: upstream.id, result: 'up-a' });
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: {
        subscription: 'up-a',
        result: {
          event: 'initialized',
          finalizedBlockHashes: ['0xfinal'],
          finalizedBlockRuntime: { type: 'valid' },
        },
      },
    });
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: {
        subscription: 'up-a',
        result: {
          event: 'newBlock',
          blockHash: '0xblock-1',
          parentBlockHash: '0xfinal',
        },
      },
    });
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: {
        subscription: 'up-a',
        result: {
          event: 'newBlock',
          blockHash: '0xblock-2',
          parentBlockHash: '0xblock-1',
        },
      },
    });
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: {
        subscription: 'up-a',
        result: {
          event: 'bestBlockChanged',
          bestBlockHash: '0xblock-2',
        },
      },
    });

    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'chainHead_v1_follow',
        params: [true],
      }),
    );

    const localTokenB = (JSON.parse(messagesB[0] ?? '{}') as { result: string }).result;
    expect(messagesB.slice(1)).toEqual([
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: {
          subscription: localTokenB,
          result: {
            event: 'initialized',
            finalizedBlockHashes: ['0xfinal'],
            finalizedBlockRuntime: { type: 'valid' },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: {
          subscription: localTokenB,
          result: {
            event: 'newBlock',
            blockHash: '0xblock-1',
            parentBlockHash: '0xfinal',
          },
        },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: {
          subscription: localTokenB,
          result: {
            event: 'newBlock',
            blockHash: '0xblock-2',
            parentBlockHash: '0xblock-1',
          },
        },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: {
          subscription: localTokenB,
          result: {
            event: 'bestBlockChanged',
            bestBlockHash: '0xblock-2',
          },
        },
      }),
    ]);
  });

  it('isolates concurrent statement-store subscriptions with duplicate client ids', () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const localProvider = manager.getLocalProvider('people');
    const messagesA: JsonRpcMessage[] = [];
    const messagesB: JsonRpcMessage[] = [];
    const connectionA = localProvider?.(message => messagesA.push(message));
    const connectionB = localProvider?.(message => messagesB.push(message));

    connectionA?.send({
      jsonrpc: '2.0',
      id: 'truapi:1',
      method: 'statement_subscribeStatement',
      params: [{ matchAll: [{ key: 'topic', value: 'a' }] }],
    });
    connectionB?.send({
      jsonrpc: '2.0',
      id: 'truapi:1',
      method: 'statement_subscribeStatement',
      params: [{ matchAll: [{ key: 'topic', value: 'b' }] }],
    });

    const upstreamA = harness.sent[0] as { id: string };
    const upstreamB = harness.sent[1] as { id: string };
    expect(upstreamA.id).not.toBe(upstreamB.id);

    harness.emit({
      jsonrpc: '2.0',
      id: upstreamB.id,
      result: 'upstream-sub-b',
    });
    harness.emit({
      jsonrpc: '2.0',
      id: upstreamA.id,
      result: 'upstream-sub-a',
    });

    const responseA = messagesA[0] as { id: string; result: string };
    const responseB = messagesB[0] as { id: string; result: string };
    expect(responseA.id).toBe('truapi:1');
    expect(responseB.id).toBe('truapi:1');
    expect(responseA.result).not.toBe(responseB.result);

    harness.emit({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: 'upstream-sub-b',
        result: { event: 'newStatements', statements: ['b'] },
      },
    });

    expect(messagesA).toHaveLength(1);
    expect(messagesB[1]).toEqual({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: responseB.result,
        result: { event: 'newStatements', statements: ['b'] },
      },
    });

    connectionA?.disconnect();
    expect(harness.sent.at(-1)).toMatchObject({
      method: 'statement_unsubscribeStatement',
      params: ['upstream-sub-a'],
    });
  });

  it('forwards exactly one upstream unpin when two sessions unpin the same shared block', () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', message => {
      messagesA.push(message);
    });
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', message => {
      messagesB.push(message);
    });

    // Both tabs follow with identical params -> coalesced to ONE upstream follow.
    connectionA?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'chainHead_v1_follow',
        params: [true],
      }),
    );
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'chainHead_v1_follow',
        params: [true],
      }),
    );

    expect(harness.sent).toHaveLength(1);
    const upstream = harness.sent[0] as { id: string };
    harness.emit({ jsonrpc: '2.0', id: upstream.id, result: 'up-a' });

    const localTokenA = (JSON.parse(messagesA[0] ?? '{}') as { result: string }).result;
    const localTokenB = (JSON.parse(messagesB[0] ?? '{}') as { result: string }).result;
    expect(localTokenA).not.toBe(localTokenB);

    // The upstream reports a block; it fans out to both sessions, so both now
    // hold a pin on it.
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: {
        subscription: 'up-a',
        result: { event: 'newBlock', blockHash: '0xblock' },
      },
    });
    // Current forks belong to the replay snapshot too. Finalize past this
    // block before checking that the last consumer can release its history.
    for (const result of [
      { event: 'newBlock', blockHash: '0xnext', parentBlockHash: '0xblock' },
      { event: 'bestBlockChanged', bestBlockHash: '0xnext' },
      {
        event: 'finalized',
        finalizedBlockHashes: ['0xblock', '0xnext'],
        prunedBlockHashes: [],
      },
    ]) {
      harness.emit({
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: { subscription: 'up-a', result },
      });
    }

    // First tab unpins: still held by the second tab, so nothing forwarded.
    connectionA?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'chainHead_v1_unpin',
        params: [localTokenA, '0xblock'],
      }),
    );
    expect(harness.sent.filter(message => message.method === 'chainHead_v1_unpin')).toHaveLength(0);
    // ...but the tab still gets a success response immediately.
    expect(JSON.parse(messagesA.at(-1) ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 10,
      result: null,
    });

    // Second (last) tab unpins: now no session holds the block -> forward once.
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'chainHead_v1_unpin',
        params: [localTokenB, '0xblock'],
      }),
    );

    const unpins = harness.sent.filter(message => message.method === 'chainHead_v1_unpin');
    expect(unpins).toHaveLength(1);
    expect((unpins[0]?.params as unknown[])[0]).toBe('up-a');
    expect((unpins[0]?.params as unknown[])[1]).toEqual(['0xblock']);
    expect(JSON.parse(messagesB.at(-1) ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 11,
      result: null,
    });
  });

  it('unpins a block upstream when its last holder disconnects (other sessions remain)', () => {
    const harness = createProviderHarness();
    const manager = createChainBrokerManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', m => messagesA.push(m));
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', m => messagesB.push(m));

    connectionA?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'chainHead_v1_follow',
        params: [true],
      }),
    );
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'chainHead_v1_follow',
        params: [true],
      }),
    );
    harness.emit({
      jsonrpc: '2.0',
      id: (harness.sent[0] as { id: string }).id,
      result: 'up-a',
    });
    const localTokenB = (JSON.parse(messagesB[0] ?? '{}') as { result: string }).result;

    // Both sessions hold the block.
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: {
        subscription: 'up-a',
        result: { event: 'newBlock', blockHash: '0xblock' },
      },
    });
    for (const result of [
      { event: 'newBlock', blockHash: '0xnext', parentBlockHash: '0xblock' },
      { event: 'bestBlockChanged', bestBlockHash: '0xnext' },
      {
        event: 'finalized',
        finalizedBlockHashes: ['0xblock', '0xnext'],
        prunedBlockHashes: [],
      },
    ]) {
      harness.emit({
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: { subscription: 'up-a', result },
      });
    }

    // Session B unpins via its own token; A is still a holder -> no forward.
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'chainHead_v1_unpin',
        params: [localTokenB, '0xblock'],
      }),
    );
    expect(harness.sent.filter(m => m.method === 'chainHead_v1_unpin')).toHaveLength(0);

    // A is now the sole holder. A disconnects while B is still following, so
    // the block is orphaned and the broker unpins it upstream exactly once.
    connectionA?.disconnect();

    const unpins = harness.sent.filter(m => m.method === 'chainHead_v1_unpin');
    expect(unpins).toHaveLength(1);
    expect((unpins[0]?.params as unknown[])[0]).toBe('up-a');
    expect((unpins[0]?.params as unknown[])[1]).toEqual(['0xblock']);
  });

  it('fails pending reads and shared follows once, without notifying closed sessions', () => {
    const harness = createProviderHarness();
    let halt = (): void => {};
    const manager = createChainBrokerManager((_genesis, onHalt) => {
      halt = onHalt;
      return harness.provider;
    });
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const closedMessages: string[] = [];
    const a = manager.connectRemote('people', 'a', message => messagesA.push(message));
    const b = manager.connectRemote('people', 'b', message => messagesB.push(message));
    const closed = manager.connectRemote('people', 'closed', message => closedMessages.push(message));
    a?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }));
    a?.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'chainHead_v1_follow', params: [true] }));
    b?.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'chainHead_v1_follow', params: [true] }));
    closed?.send(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'chainHead_v1_follow', params: [true] }));
    closed?.send(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'system_health', params: [] }));
    closed?.disconnect();
    halt();
    halt();
    const error = { code: -32603 };
    expect(messagesA.map(message => JSON.parse(message) as unknown)).toMatchObject([
      { jsonrpc: '2.0', id: 1, error },
      { jsonrpc: '2.0', id: 2, error },
    ]);
    expect(messagesB.map(message => JSON.parse(message) as unknown)).toMatchObject([{ jsonrpc: '2.0', id: 3, error }]);
    expect(closedMessages).toEqual([]);
    // Late replies from the halted generation must not complete failed requests.
    for (const request of harness.sent) {
      harness.emit({ jsonrpc: '2.0', id: requestId(request), result: 'stale' });
    }
    expect(messagesA).toHaveLength(2);
    expect(messagesB).toHaveLength(1);
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
  });

  it('terminates statement and transaction watches using their protocol terminal forms', () => {
    const harness = createProviderHarness();
    let halt = (): void => {};
    const manager = createChainBrokerManager((_genesis, onHalt) => {
      halt = onHalt;
      return harness.provider;
    });
    const messages: JsonRpcMessage[] = [];
    const connection = manager.getLocalProvider('people')?.(message => messages.push(message));
    const methods = [
      'statement_subscribeStatement',
      'author_submitAndWatchExtrinsic',
      'transactionWatch_v1_submitAndWatch',
      'transaction_v1_broadcast',
    ];
    for (const [id, method] of methods.entries()) {
      connection?.send({ jsonrpc: '2.0', id, method, params: [] });
      harness.emit({ jsonrpc: '2.0', id: requestId(harness.sent[id]), result: `up-${String(id)}` });
    }
    const tokens = messages.map(subscriptionToken);
    messages.length = 0;
    halt();
    expect(messages).toMatchObject([
      {
        jsonrpc: '2.0',
        method: 'statement_statement',
        params: {
          subscription: tokens[0],
          error: { code: -32603 },
        },
      },
      { jsonrpc: '2.0', method: 'author_extrinsicUpdate', params: { subscription: tokens[1], result: 'dropped' } },
      {
        jsonrpc: '2.0',
        method: 'transactionWatch_v1_watchEvent',
        params: { subscription: tokens[2], result: { event: 'error' } },
      },
    ]);
  });

  it('reconnects lazily and isolates renewed statements even when the server reuses its token', () => {
    const generations: { harness: ProviderHarness; halt: () => void }[] = [];
    const manager = createChainBrokerManager((_genesis, halt) => {
      const harness = createProviderHarness();
      generations.push({ harness, halt });
      return harness.provider;
    });
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const a = manager.connectRemote('people', 'a', message => messagesA.push(message));
    const b = manager.connectRemote('people', 'b', message => messagesB.push(message));
    const first = required(generations[0]);
    a?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'statement_subscribeStatement', params: ['any'] }));
    b?.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'statement_subscribeStatement', params: ['any'] }));
    for (const request of first.harness.sent) {
      first.harness.emit({ jsonrpc: '2.0', id: requestId(request), result: 'reused-token' });
    }
    const oldToken = subscriptionToken(messagesA[0]);
    b?.disconnect();
    first.halt();
    expect(generations).toHaveLength(1);
    expect(messagesB).toHaveLength(1);
    a?.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'statement_subscribeStatement', params: ['any'] }));
    const second = required(generations[1]);
    const notification: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: { subscription: 'reused-token', result: { event: 'newStatements', data: { statements: ['0x01'] } } },
    };
    // This must not be buffered as an early event for the replacement subscription.
    first.harness.emit(notification);
    first.halt();
    second.harness.emit({ jsonrpc: '2.0', id: requestId(second.harness.sent[0]), result: 'reused-token' });
    const newToken = subscriptionToken(messagesA[2]);
    expect(newToken).not.toBe(oldToken);
    expect(messagesA).toHaveLength(3);
    second.harness.emit(notification);
    expect(JSON.parse(required(messagesA[3]))).toEqual({
      ...notification,
      params: { subscription: newToken, result: { event: 'newStatements', data: { statements: ['0x01'] } } },
    });
    expect(messagesB).toHaveLength(1);
    a?.disconnect();
    expect(second.harness.sent.at(-1)).toMatchObject({
      method: 'statement_unsubscribeStatement',
      params: ['reused-token'],
    });
    manager.disconnectAll();
    expect(second.harness.disconnect).toHaveBeenCalledTimes(1);
  });

  it('stops every shared follow and allows synchronous refollow without replaying the old snapshot', () => {
    const generations: { harness: ProviderHarness; halt: () => void }[] = [];
    const manager = createChainBrokerManager((_genesis, halt) => {
      const harness = createProviderHarness();
      generations.push({ harness, halt });
      return harness.provider;
    });
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const a = manager.connectRemote('people', 'a', message => {
      messagesA.push(message);
      const parsed = JSON.parse(message) as { params?: { result?: { event?: string } } };
      if (parsed.params?.result?.event === 'stop') {
        a?.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'chainHead_v1_follow', params: [true] }));
      }
    });
    const b = manager.connectRemote('people', 'b', message => messagesB.push(message));
    a?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] }));
    b?.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'chainHead_v1_follow', params: [true] }));
    const first = required(generations[0]);
    first.harness.emit({ jsonrpc: '2.0', id: requestId(first.harness.sent[0]), result: 'old-follow' });
    first.harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: 'old-follow', result: { event: 'initialized', finalizedBlockHashes: ['old-block'] } },
    });
    const tokenA = subscriptionToken(messagesA[0]);
    const tokenB = subscriptionToken(messagesB[0]);
    first.halt();
    expect(JSON.parse(required(messagesA[2]))).toEqual({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: tokenA, result: { event: 'stop' } },
    });
    expect(JSON.parse(required(messagesB[2]))).toEqual({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: tokenB, result: { event: 'stop' } },
    });
    const second = required(generations[1]);
    second.harness.emit({ jsonrpc: '2.0', id: requestId(second.harness.sent[0]), result: 'new-follow' });
    const newToken = subscriptionToken(messagesA[3]);
    expect(newToken).not.toBe(tokenA);
    expect(messagesA).toHaveLength(4);
    second.harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: 'new-follow', result: { event: 'initialized', finalizedBlockHashes: ['new-block'] } },
    });
    expect(JSON.parse(required(messagesA[4]))).toEqual({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: newToken, result: { event: 'initialized', finalizedBlockHashes: ['new-block'] } },
    });
    expect(messagesB).toHaveLength(3);
  });

  it('does not resurrect a provider that halts synchronously during connection', () => {
    const staleDisconnect = vi.fn();
    const fresh = createProviderHarness();
    let generation = 0;
    let halt = (): void => {};
    const manager = createChainBrokerManager((_genesis, onHalt) => {
      halt = onHalt;
      generation += 1;
      if (generation === 1) {
        return () => {
          onHalt();
          return {
            send: () => {
              throw new Error('stale send');
            },
            disconnect: staleDisconnect,
          };
        };
      }
      return fresh.provider;
    });
    const messages: string[] = [];
    const connection = manager.connectRemote('people', 'a', message => messages.push(message));
    expect(staleDisconnect).toHaveBeenCalledTimes(1);
    connection?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }));
    fresh.emit({ jsonrpc: '2.0', id: requestId(fresh.sent[0]), result: { peers: 1 } });
    expect(JSON.parse(required(messages[0]))).toEqual({ jsonrpc: '2.0', id: 1, result: { peers: 1 } });
    halt();
    expect(fresh.disconnect).toHaveBeenCalledTimes(1);
  });

  it('fails an in-flight request when send synchronously reports a halt', () => {
    const disconnect = vi.fn();
    const manager = createChainBrokerManager((_genesis, onHalt) => () => ({
      send: () => {
        onHalt();
      },
      disconnect,
    }));
    const messages: string[] = [];
    const connection = manager.connectRemote('people', 'a', message => messages.push(message));
    connection?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }));
    expect(messages.map(message => JSON.parse(message) as unknown)).toMatchObject([
      { jsonrpc: '2.0', id: 1, error: { code: -32603 } },
    ]);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
