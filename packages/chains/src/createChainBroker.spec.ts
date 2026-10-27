// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { bindLogSink, isRecord } from '@dotli/shared';
import { catchError, must } from '@dotli/shared/testing';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { createChainBroker, type ChainBroker } from './createChainBroker.js';
import { createChainPool } from './createChainPool.js';
import { collectWarningsDuring } from './testing/collectWarningsDuring.js';

/** The broker suites' manager: a pool that keeps its chains, with transports built without hooks. */
function createManager(
  createProvider: (genesisHash: string) => JsonRpcProvider | null,
): ReturnType<typeof createChainPool> {
  return createChainPool({ createTransport: genesisHash => createProvider(genesisHash), destroyDelay: Infinity });
}

/** An upstream provider that records what the broker sends and emits what the node would answer. */
function createProviderHarness() {
  const sent: JsonRpcRequest<unknown>[] = [];
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
    emit(message: JsonRpcMessage) {
      onMessage?.(message);
    },
  };
}

/** Reads a request the broker sent upstream, failing the test when it is missing or lacks a string id or params list. */
function readUpstreamRequest(request: JsonRpcRequest<unknown> | undefined): {
  id: string;
  method: string;
  params: unknown[];
} {
  const { id, method, params } = must(request, 'upstream request');
  if (typeof id !== 'string' || !Array.isArray(params)) {
    throw new Error(`Upstream request ${JSON.stringify(request)} has no string id or no params list`);
  }
  return { id, method, params };
}

/** Reads the answer a session heard, failing the test when it carries no string result. */
function readAnswer(message: unknown): { id: unknown; result: string } {
  if (!isRecord(message) || typeof message['result'] !== 'string') {
    throw new Error(`Session message ${JSON.stringify(message)} carries no string result`);
  }
  return { id: message['id'], result: message['result'] };
}

/** Reads the result of a subscription event a session heard, failing the test when it has none. */
function readEventResult(message: unknown): Record<string, unknown> {
  const params = isRecord(message) ? message['params'] : undefined;
  const result = isRecord(params) ? params['result'] : undefined;
  if (!isRecord(result)) {
    throw new Error(`Session message ${JSON.stringify(message)} is no subscription event`);
  }
  return result;
}

describe('chain pool brokering', () => {
  it('As a session sharing a chain with another, I send a request under my own id and get my own response back', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(genesisHash => (genesisHash === 'asset-hub' ? harness.provider : null));

    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = must(
      manager.connectRemote('asset-hub', 'conn-a', message => {
        messagesA.push(message);
      }),
      'connection A',
    );
    const connectionB = must(
      manager.connectRemote('asset-hub', 'conn-b', message => {
        messagesB.push(message);
      }),
      'connection B',
    );

    // When
    connectionA.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'chainHead_v1_header',
        params: ['token-a', '0xabc'],
      }),
    );
    connectionB.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'chainHead_v1_header',
        params: ['token-b', '0xdef'],
      }),
    );

    const upstreamA = readUpstreamRequest(harness.sent[0]);
    const upstreamB = readUpstreamRequest(harness.sent[1]);

    harness.emit({ jsonrpc: '2.0', id: upstreamB.id, result: 'header-b' });
    harness.emit({ jsonrpc: '2.0', id: upstreamA.id, result: 'header-a' });

    // Then
    expect(messagesA).toEqual([JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'header-a' })]);
    expect(messagesB).toEqual([JSON.stringify({ jsonrpc: '2.0', id: 7, result: 'header-b' })]);
  });

  it('As a session following a chain another session follows, I share one upstream follow and hear its events under my own token', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', message => {
      messagesA.push(message);
    });
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', message => {
      messagesB.push(message);
    });

    // When
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

    // Then
    expect(harness.sent).toHaveLength(1);

    // When
    const upstream = readUpstreamRequest(harness.sent[0]);
    harness.emit({ jsonrpc: '2.0', id: upstream.id, result: 'up-a' });

    // Then
    const localTokenA = readAnswer(JSON.parse(messagesA[0] ?? '{}')).result;
    const localTokenB = readAnswer(JSON.parse(messagesB[0] ?? '{}')).result;
    expect(localTokenA).not.toBe(localTokenB);

    // When
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: 'up-a', result: { event: 'bestBlockChanged' } },
    });

    // Then
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

  it('As a session that disconnects, I have my subscriptions released and the upstream stays warm until the pool disconnects all', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const connection = manager.connectRemote('asset-hub', 'conn-a', () => {});

    connection?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'chainHead_v1_follow',
        params: [true],
      }),
    );

    const upstreamRequest = readUpstreamRequest(harness.sent[0]);
    harness.emit({ jsonrpc: '2.0', id: upstreamRequest.id, result: 'up-a' });

    // When
    connection?.disconnect();

    // Then
    const release = readUpstreamRequest(harness.sent[1]);
    expect(release.method).toBe('chainHead_v1_unfollow');
    expect(release.params[0]).toBe('up-a');
    expect(harness.disconnect).not.toHaveBeenCalled();

    // When
    manager.disconnectAll();

    // Then
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a session that disconnects, I have my transaction watch released upstream', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const connection = manager.connectRemote('asset-hub', 'conn-a', () => {});

    // When
    connection?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionWatch_v1_submitAndWatch',
        params: ['0x0102'],
      }),
    );

    // Then
    const upstreamRequest = readUpstreamRequest(harness.sent[0]);
    expect(upstreamRequest.method).toBe('transactionWatch_v1_submitAndWatch');

    // When
    harness.emit({ jsonrpc: '2.0', id: upstreamRequest.id, result: 'up-tx' });
    connection?.disconnect();

    // Then
    const release = readUpstreamRequest(harness.sent[1]);
    expect(release.method).toBe('transactionWatch_v1_unwatch');
    expect(release.params[0]).toBe('up-tx');
  });

  it('As a session watching a transaction, I hear an event that arrived before my subscription answer, once it is answered', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
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

    // When
    const upstreamRequest = readUpstreamRequest(harness.sent[0]);
    harness.emit({
      jsonrpc: '2.0',
      method: 'transactionWatch_v1_watchEvent',
      params: {
        subscription: 'up-tx',
        result: { event: 'finalized', block: { hash: '0xabc' } },
      },
    });

    // Then
    expect(messages).toEqual([]);

    // When
    harness.emit({
      jsonrpc: '2.0',
      id: upstreamRequest.id,
      result: 'up-tx',
    });

    // Then
    const response = readAnswer(JSON.parse(messages[0] ?? '{}'));
    expect(JSON.parse(messages[1] ?? '{}')).toEqual({
      jsonrpc: '2.0',
      method: 'transactionWatch_v1_watchEvent',
      params: {
        subscription: response.result,
        result: { event: 'finalized', block: { hash: '0xabc' } },
      },
    });
  });

  it('As a session subscribed to the statements another session follows, I hear every statement and the upstream subscription ends only once we both left', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
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

    // When
    harness.emit({
      jsonrpc: '2.0',
      id: readUpstreamRequest(harness.sent[0]).id,
      result: 'up-stmt',
    });
    harness.emit({
      jsonrpc: '2.0',
      id: readUpstreamRequest(harness.sent[1]).id,
      result: 'up-stmt',
    });

    // Then
    const localTokenA = readAnswer(JSON.parse(messagesA[0] ?? '{}')).result;
    const localTokenB = readAnswer(JSON.parse(messagesB[0] ?? '{}')).result;
    expect(localTokenA).not.toBe(localTokenB);

    // When
    harness.emit({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: 'up-stmt',
        result: { event: 'newStatements', data: { statements: [] } },
      },
    });

    // Then
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

    // When
    connectionA?.disconnect();

    // Then
    expect(harness.sent.filter(message => message.method === 'statement_unsubscribeStatement')).toHaveLength(0);

    // When
    connectionB?.disconnect();

    // Then
    const releases = harness.sent.filter(message => message.method === 'statement_unsubscribeStatement');
    expect(releases).toHaveLength(1);
    expect(readUpstreamRequest(releases[0]).params[0]).toBe('up-stmt');
  });

  it('As a session sharing a statement subscription, I unsubscribe and the other session keeps hearing statements until it unsubscribes too', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
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
      id: readUpstreamRequest(harness.sent[0]).id,
      result: 'up-stmt',
    });
    harness.emit({
      jsonrpc: '2.0',
      id: readUpstreamRequest(harness.sent[1]).id,
      result: 'up-stmt',
    });
    const localTokenA = readAnswer(JSON.parse(messagesA[0] ?? '{}')).result;
    const localTokenB = readAnswer(JSON.parse(messagesB[0] ?? '{}')).result;

    // When
    connectionA?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'statement_unsubscribeStatement',
        params: [localTokenA],
      }),
    );

    // Then
    expect(JSON.parse(messagesA.at(-1) ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 10,
      result: true,
    });
    expect(harness.sent.filter(message => message.method === 'statement_unsubscribeStatement')).toHaveLength(0);

    // When
    harness.emit({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: 'up-stmt',
        result: { event: 'newStatements', data: { statements: [] } },
      },
    });

    // Then
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

    // When
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'statement_unsubscribeStatement',
        params: [localTokenB],
      }),
    );

    // Then
    const release = readUpstreamRequest(harness.sent.at(-1));
    expect(release.method).toBe('statement_unsubscribeStatement');
    expect(release.params[0]).toBe('up-stmt');

    // When
    harness.emit({
      jsonrpc: '2.0',
      id: release.id,
      result: true,
    });

    // Then
    expect(JSON.parse(messagesB.at(-1) ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 11,
      result: true,
    });
  });

  it('As a session attaching after every other one left, I reuse the warm upstream', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);

    // When
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', () => {});
    connectionA?.disconnect();

    // Then
    expect(harness.disconnect).not.toHaveBeenCalled();

    // When
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', () => {});
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'chainSpec_v1_chainName',
        params: [],
      }),
    );

    // Then
    expect(harness.sent.at(-1)).toMatchObject({
      method: 'chainSpec_v1_chainName',
    });
    expect(harness.disconnect).not.toHaveBeenCalled();

    // When
    manager.disconnectAll();

    // Then
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a session joining a follow another one holds, I hear the cached blocks replayed in order', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
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

    const upstream = readUpstreamRequest(harness.sent[0]);
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

    // When
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'chainHead_v1_follow',
        params: [true],
      }),
    );

    // Then
    const localTokenB = readAnswer(JSON.parse(messagesB[0] ?? '{}')).result;
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

  it('As a dApp user sharing a new follow, I keep my blocks pinned when another session unpins them as it hears initialized', () => {
    // Given A releases the older finalized blocks inside its own delivery, as polkadot-api does
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const messagesB: string[] = [];
    let tokenA = '';
    const connectionA = manager.connectRemote('bulletin', 'conn-a', raw => {
      // The string wire carries the JSON-RPC message the broker built.
      const message = JSON.parse(raw) as {
        id?: number;
        result?: string;
        params?: { result?: Record<string, unknown> };
      };
      if (message.id === 1) {
        tokenA = message.result ?? '';
      }
      const result = message.params?.result;
      if (result?.['event'] === 'initialized') {
        // An initialized event lists its finalized blocks by hash.
        const hashes = result['finalizedBlockHashes'] as string[];
        connectionA?.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'chainHead_v1_unpin',
            params: [tokenA, hashes.slice(0, -1)],
          }),
        );
      }
    });
    const connectionB = manager.connectRemote('bulletin', 'conn-b', message => messagesB.push(message));
    connectionA?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] }));
    connectionB?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] }));
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-a' });

    // When
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: {
        subscription: 'up-a',
        result: { event: 'initialized', finalizedBlockHashes: ['0xf0', '0xf1', '0xf2'], finalizedBlockRuntime: null },
      },
    });

    // Then
    const initializedB = readEventResult(JSON.parse(messagesB[1] ?? '{}'));
    expect(initializedB['finalizedBlockHashes']).toEqual(['0xf0', '0xf1', '0xf2']);
    expect(harness.sent.filter(message => message.method === 'chainHead_v1_unpin')).toEqual([]);
  });

  it('As a dApp user, I join a follow another session holds and am replayed only blocks still pinned upstream', () => {
    // Given session A follows, sees two blocks finalized and a third on top,
    // then unpins what it no longer needs, as papi does
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', message => messagesA.push(message));
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', message => messagesB.push(message));
    connectionA?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] }));
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-a' });
    const localTokenA = readAnswer(JSON.parse(messagesA[0] ?? '{}')).result;
    function emitFollowEvent(result: Record<string, unknown>): void {
      harness.emit({ jsonrpc: '2.0', method: 'chainHead_v1_followEvent', params: { subscription: 'up-a', result } });
    }
    emitFollowEvent({ event: 'initialized', finalizedBlockHashes: ['0xf0'], finalizedBlockRuntime: { type: 'valid' } });
    emitFollowEvent({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });
    emitFollowEvent({ event: 'newBlock', blockHash: '0xb2', parentBlockHash: '0xb1' });
    emitFollowEvent({ event: 'finalized', finalizedBlockHashes: ['0xb1', '0xb2'], prunedBlockHashes: [] });
    emitFollowEvent({ event: 'newBlock', blockHash: '0xb3', parentBlockHash: '0xb2' });
    emitFollowEvent({ event: 'bestBlockChanged', bestBlockHash: '0xb3' });
    connectionA?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'chainHead_v1_unpin',
        params: [localTokenA, ['0xf0', '0xb1', '0xb3']],
      }),
    );

    // When
    connectionB?.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'chainHead_v1_follow', params: [true] }));

    // Then B starts from the newest finalized block, and every block it hears of is still pinned
    const unpinned = harness.sent
      .filter(message => message.method === 'chainHead_v1_unpin')
      .flatMap(message => readUpstreamRequest(message).params[1]);
    const replay = messagesB.slice(1).map(message => readEventResult(JSON.parse(message)));
    expect(replay).toEqual([
      { event: 'initialized', finalizedBlockHashes: ['0xb2'], finalizedBlockRuntime: { type: 'valid' } },
      { event: 'newBlock', blockHash: '0xb3', parentBlockHash: '0xb2' },
      { event: 'bestBlockChanged', bestBlockHash: '0xb3' },
    ]);
    expect(unpinned).not.toContain('0xb2');
    expect(unpinned).not.toContain('0xb3');
  });

  it('As a dApp user, I join a follow after a runtime upgrade was finalized and am replayed the upgraded runtime', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', () => undefined);
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', message => messagesB.push(message));
    connectionA?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] }));
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-a' });
    function emitFollowEvent(result: Record<string, unknown>): void {
      harness.emit({ jsonrpc: '2.0', method: 'chainHead_v1_followEvent', params: { subscription: 'up-a', result } });
    }
    emitFollowEvent({
      event: 'initialized',
      finalizedBlockHashes: ['0xf0'],
      finalizedBlockRuntime: { type: 'valid', spec: 1 },
    });
    emitFollowEvent({
      event: 'newBlock',
      blockHash: '0xb1',
      parentBlockHash: '0xf0',
      newRuntime: { type: 'valid', spec: 2 },
    });
    emitFollowEvent({ event: 'finalized', finalizedBlockHashes: ['0xb1'], prunedBlockHashes: [] });

    // When
    connectionB?.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'chainHead_v1_follow', params: [true] }));

    // Then
    expect(readEventResult(JSON.parse(messagesB[1] ?? '{}'))).toEqual({
      event: 'initialized',
      finalizedBlockHashes: ['0xb1'],
      finalizedBlockRuntime: { type: 'valid', spec: 2 },
    });
  });

  it('As a dApp user, I unfollow inside the answer to my join and hear no replay, and my blocks stay unpinned by me', () => {
    // Given a follow A holds, and a session B that unfollows as soon as it hears its token
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    const messagesA: unknown[] = [];
    const messagesB: unknown[] = [];
    const connectionA = broker.connect({
      sessionId: 'a',
      onMessage: message => messagesA.push(message),
      wireMode: 'object',
    });
    connectionA.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-1' });
    const tokenA = readAnswer(messagesA[0]).result;
    function emitFollowEvent(result: Record<string, unknown>): void {
      harness.emit({ jsonrpc: '2.0', method: 'chainHead_v1_followEvent', params: { subscription: 'up-1', result } });
    }
    emitFollowEvent({ event: 'initialized', finalizedBlockHashes: ['0xf0'] });
    const connectionB = broker.connect({
      sessionId: 'b',
      onMessage: message => {
        messagesB.push(message);
        const result = isRecord(message) ? message['result'] : undefined;
        if (isRecord(message) && message['id'] === 2 && typeof result === 'string') {
          connectionB.send({ jsonrpc: '2.0', id: 3, method: 'chainHead_v1_unfollow', params: [result] });
        }
      },
      wireMode: 'object',
    });

    // When B joins and unfollows inside the answer, the chain finalizes past 0xf0, and A unpins it
    connectionB.send({ jsonrpc: '2.0', id: 2, method: 'chainHead_v1_follow', params: [true] });
    emitFollowEvent({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });
    emitFollowEvent({ event: 'finalized', finalizedBlockHashes: ['0xb1'], prunedBlockHashes: [] });
    connectionA.send({ jsonrpc: '2.0', id: 4, method: 'chainHead_v1_unpin', params: [tokenA, ['0xf0']] });

    // Then B heard only its token and its unfollow answer, and 0xf0 is unpinned upstream
    expect(messagesB).toEqual([
      // An asymmetric matcher is typed any.
      { jsonrpc: '2.0', id: 2, result: expect.any(String) as string },
      { jsonrpc: '2.0', id: 3, result: null },
    ]);
    expect(
      harness.sent.filter(message => message.method === 'chainHead_v1_unpin').map(message => message.params),
    ).toEqual([['up-1', ['0xf0']]]);
  });

  it('As the host page, I get a local provider on the same upstream as remote sessions and each gets its own answers', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const localProvider = must(manager.getLocalProvider('asset-hub'), 'local provider');
    const remoteMessages: string[] = [];

    // `getLocalProvider` uses the object wire. `connectRemote` uses the string wire.
    const localMessages: JsonRpcMessage[] = [];
    const localConnection = localProvider(message => {
      localMessages.push(message);
    });
    const remoteConnection = manager.connectRemote('asset-hub', 'conn-a', message => {
      remoteMessages.push(message);
    });

    // When
    localConnection.send({
      jsonrpc: '2.0',
      id: 'local-1',
      method: 'chainHead_v1_header',
      params: ['token', '0xabc'],
    });
    remoteConnection?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'remote-1',
        method: 'chainHead_v1_header',
        params: ['token', '0xdef'],
      }),
    );

    const localUpstream = readUpstreamRequest(harness.sent[0]);
    const remoteUpstream = readUpstreamRequest(harness.sent[1]);

    harness.emit({
      jsonrpc: '2.0',
      id: localUpstream.id,
      result: 'local-result',
    });
    harness.emit({
      jsonrpc: '2.0',
      id: remoteUpstream.id,
      result: 'remote-result',
    });

    // Then
    expect(localMessages).toEqual([{ jsonrpc: '2.0', id: 'local-1', result: 'local-result' }]);
    expect(remoteMessages).toEqual([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'remote-1',
        result: 'remote-result',
      }),
    ]);
  });

  it('As a session using the same client id as another, I subscribe to my statements and hear only mine', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const localProvider = manager.getLocalProvider('people');
    const messagesA: JsonRpcMessage[] = [];
    const messagesB: JsonRpcMessage[] = [];
    const connectionA = localProvider?.(message => messagesA.push(message));
    const connectionB = localProvider?.(message => messagesB.push(message));

    // When
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

    // Then
    const upstreamA = readUpstreamRequest(harness.sent[0]);
    const upstreamB = readUpstreamRequest(harness.sent[1]);
    expect(upstreamA.id).not.toBe(upstreamB.id);

    // When
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

    // Then
    const responseA = readAnswer(messagesA[0]);
    const responseB = readAnswer(messagesB[0]);
    expect(responseA.id).toBe('truapi:1');
    expect(responseB.id).toBe('truapi:1');
    expect(responseA.result).not.toBe(responseB.result);

    // When
    harness.emit({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: 'upstream-sub-b',
        result: { event: 'newStatements', statements: ['b'] },
      },
    });

    // Then
    expect(messagesA).toHaveLength(1);
    expect(messagesB[1]).toEqual({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: responseB.result,
        result: { event: 'newStatements', statements: ['b'] },
      },
    });

    // When
    connectionA?.disconnect();

    // Then
    expect(harness.sent.at(-1)).toMatchObject({
      method: 'statement_unsubscribeStatement',
      params: ['upstream-sub-a'],
    });
  });

  it('As a session holding a block another session holds, I unpin it and the upstream gets one unpin once we both have', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', message => {
      messagesA.push(message);
    });
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', message => {
      messagesB.push(message);
    });

    // When
    // Identical follows from both tabs coalesce into one upstream follow.
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

    // Then
    expect(harness.sent).toHaveLength(1);

    // When
    const upstream = readUpstreamRequest(harness.sent[0]);
    harness.emit({ jsonrpc: '2.0', id: upstream.id, result: 'up-a' });

    // Then
    const localTokenA = readAnswer(JSON.parse(messagesA[0] ?? '{}')).result;
    const localTokenB = readAnswer(JSON.parse(messagesB[0] ?? '{}')).result;
    expect(localTokenA).not.toBe(localTokenB);

    // When
    // The block fans out to both sessions, so both pin it.
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: {
        subscription: 'up-a',
        result: { event: 'newBlock', blockHash: '0xblock' },
      },
    });
    // Finalizing past it leaves the sessions as its only holders.
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: {
        subscription: 'up-a',
        result: { event: 'finalized', finalizedBlockHashes: ['0xblock', '0xnext'], prunedBlockHashes: [] },
      },
    });
    // Still held by the second tab, so nothing is forwarded.
    connectionA?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'chainHead_v1_unpin',
        params: [localTokenA, '0xblock'],
      }),
    );

    // Then
    expect(harness.sent.filter(message => message.method === 'chainHead_v1_unpin')).toHaveLength(0);
    // The tab still gets a success response at once.
    expect(JSON.parse(messagesA.at(-1) ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 10,
      result: null,
    });

    // When
    // The last holder unpins, so the unpin goes upstream once.
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'chainHead_v1_unpin',
        params: [localTokenB, '0xblock'],
      }),
    );

    // Then
    const unpins = harness.sent.filter(message => message.method === 'chainHead_v1_unpin');
    expect(unpins).toHaveLength(1);
    expect(readUpstreamRequest(unpins[0]).params[0]).toBe('up-a');
    expect(readUpstreamRequest(unpins[0]).params[1]).toEqual(['0xblock']);
    expect(JSON.parse(messagesB.at(-1) ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 11,
      result: null,
    });
  });

  it('As the last session holding a block, I disconnect while another session follows and the block is unpinned upstream', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
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
      id: readUpstreamRequest(harness.sent[0]).id,
      result: 'up-a',
    });
    const localTokenB = readAnswer(JSON.parse(messagesB[0] ?? '{}')).result;

    // The block fans out to both sessions, so both pin it.
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: {
        subscription: 'up-a',
        result: { event: 'newBlock', blockHash: '0xblock' },
      },
    });
    // Finalizing past it leaves the sessions as its only holders.
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: {
        subscription: 'up-a',
        result: { event: 'finalized', finalizedBlockHashes: ['0xblock', '0xnext'], prunedBlockHashes: [] },
      },
    });

    // When
    // A still holds the block, so nothing is forwarded.
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'chainHead_v1_unpin',
        params: [localTokenB, '0xblock'],
      }),
    );

    // Then
    expect(harness.sent.filter(m => m.method === 'chainHead_v1_unpin')).toHaveLength(0);

    // When
    // The sole holder disconnects while B still follows, so the broker unpins upstream once.
    connectionA?.disconnect();

    // Then
    const unpins = harness.sent.filter(m => m.method === 'chainHead_v1_unpin');
    expect(unpins).toHaveLength(1);
    expect(readUpstreamRequest(unpins[0]).params[0]).toBe('up-a');
    expect(readUpstreamRequest(unpins[0]).params[1]).toEqual(['0xblock']);
  });

  it('As a session whose follow the node refuses, I hear the refusal under my own id and my next follow asks the node again', () => {
    // Given two sessions waiting on one shared follow
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', message => messagesA.push(message));
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', message => messagesB.push(message));
    connectionA?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] }));
    connectionB?.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'chainHead_v1_follow', params: [true] }));
    const refusal = { code: -32800, message: 'Too many follows' };

    // When the node refuses it
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, error: refusal });

    // Then each session hears the refusal under its own id
    expect(messagesA.map((message): unknown => JSON.parse(message))).toEqual([
      { jsonrpc: '2.0', id: 1, error: refusal },
    ]);
    expect(messagesB.map((message): unknown => JSON.parse(message))).toEqual([
      { jsonrpc: '2.0', id: 2, error: refusal },
    ]);

    // When the first session follows again and the node accepts
    connectionA?.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'chainHead_v1_follow', params: [true] }));
    const refollow = harness.sent.filter(message => message.method === 'chainHead_v1_follow')[1];
    harness.emit({ jsonrpc: '2.0', id: refollow?.id ?? 'missing', result: 'up-2' });

    // Then a fresh follow went upstream and the session got a token for it
    expect(refollow).toBeDefined();
    expect(JSON.parse(messagesA.at(-1) ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 3,
      // An asymmetric matcher is typed any.
      result: expect.any(String) as string,
    });
  });

  it.each([
    {
      kind: 'statement subscription',
      subscribe: 'statement_subscribeStatement',
      params: [{ matchAll: ['0xtopic'] }],
      release: 'statement_unsubscribeStatement',
      upstreamToken: 'up-stmt',
    },
    {
      kind: 'transaction watch',
      subscribe: 'transactionWatch_v1_submitAndWatch',
      params: ['0x0102'],
      release: 'transactionWatch_v1_unwatch',
      upstreamToken: 'up-tx',
    },
  ])(
    'As a session that disconnects before my $kind is answered, I leave no $kind running upstream',
    ({ subscribe, params, release, upstreamToken }) => {
      // Given a subscription in flight
      const harness = createProviderHarness();
      const manager = createManager(() => harness.provider);
      const connection = manager.connectRemote('asset-hub', 'conn-a', () => undefined);
      connection?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: subscribe, params }));
      const request = readUpstreamRequest(harness.sent[0]);

      // When the session leaves and only then the node answers
      connection?.disconnect();
      harness.emit({ jsonrpc: '2.0', id: request.id, result: upstreamToken });

      // Then the subscription is ended upstream
      expect(harness.sent.filter(message => message.method === release).map(message => message.params)).toEqual([
        [upstreamToken],
      ]);
    },
  );

  it('As a session sharing a statement subscription with one that left before its answer, I keep hearing statements', () => {
    // Given two sessions subscribed with the same filter, the second already answered
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', () => undefined);
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', message => messagesB.push(message));
    const subscribe = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'statement_subscribeStatement',
      params: [{ matchAll: ['0xtopic'] }],
    });
    connectionA?.send(subscribe);
    connectionB?.send(subscribe);
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[1]).id, result: 'up-stmt' });

    // When the first leaves, its answer names the same token, and a statement arrives
    connectionA?.disconnect();
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-stmt' });
    harness.emit({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: { subscription: 'up-stmt', result: { event: 'newStatements', data: { statements: [] } } },
    });

    // Then nothing was released and the survivor heard the statement
    expect(harness.sent.filter(message => message.method === 'statement_unsubscribeStatement')).toEqual([]);
    expect(messagesB).toHaveLength(2);
  });

  it.each(['finalized', 'invalid', 'dropped', 'error'])(
    'As a session whose transaction watch ended with %s, I disconnect and no unwatch goes upstream for it',
    terminal => {
      // Given an answered watch
      const harness = createProviderHarness();
      const manager = createManager(() => harness.provider);
      const messages: string[] = [];
      const connection = manager.connectRemote('asset-hub', 'conn-a', message => messages.push(message));
      connection?.send(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transactionWatch_v1_submitAndWatch', params: ['0x0102'] }),
      );
      harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-tx' });

      // When the node ends the watch and the session leaves
      harness.emit({
        jsonrpc: '2.0',
        method: 'transactionWatch_v1_watchEvent',
        params: { subscription: 'up-tx', result: { event: terminal } },
      });
      connection?.disconnect();

      // Then the session heard the end, and nothing went upstream for a watch the node already ended
      const localToken = readAnswer(JSON.parse(messages[0] ?? '{}')).result;
      expect(JSON.parse(messages[1] ?? '{}')).toEqual({
        jsonrpc: '2.0',
        method: 'transactionWatch_v1_watchEvent',
        params: { subscription: localToken, result: { event: terminal } },
      });
      expect(harness.sent.filter(message => message.method === 'transactionWatch_v1_unwatch')).toEqual([]);
    },
  );

  it('As a session, I unwatch as I hear my transaction finalized and get an unknown subscription error with nothing sent upstream', () => {
    // Given an answered watch whose session unwatches from inside the final event's delivery
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    const messages: unknown[] = [];
    let localToken = '';
    const connection = broker.connect({
      sessionId: 'a',
      onMessage: message => {
        messages.push(message);
        const method = isRecord(message) ? message['method'] : undefined;
        if (method === 'transactionWatch_v1_watchEvent') {
          connection.send({ jsonrpc: '2.0', id: 2, method: 'transactionWatch_v1_unwatch', params: [localToken] });
        }
      },
      wireMode: 'object',
    });
    connection.send({ jsonrpc: '2.0', id: 1, method: 'transactionWatch_v1_submitAndWatch', params: ['0x0102'] });
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-tx' });
    localToken = readAnswer(messages[0]).result;

    // When the node ends the watch
    harness.emit({
      jsonrpc: '2.0',
      method: 'transactionWatch_v1_watchEvent',
      params: { subscription: 'up-tx', result: { event: 'finalized', block: { hash: '0xabc', index: 0 } } },
    });

    // Then the unwatch is answered locally after the final event, and the node is not asked to unwatch
    expect(messages.slice(1)).toEqual([
      {
        jsonrpc: '2.0',
        method: 'transactionWatch_v1_watchEvent',
        params: { subscription: localToken, result: { event: 'finalized', block: { hash: '0xabc', index: 0 } } },
      },
      { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'Unknown subscription/token' } },
    ]);
    expect(harness.sent.filter(message => message.method === 'transactionWatch_v1_unwatch')).toEqual([]);
  });

  it('As a session whose transaction watch already ended, I unwatch it and get an unknown subscription error without an upstream call', () => {
    // Given a watch the node ended with a final event
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const messages: string[] = [];
    const connection = manager.connectRemote('asset-hub', 'conn-a', message => messages.push(message));
    connection?.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transactionWatch_v1_submitAndWatch', params: ['0x0102'] }),
    );
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-tx' });
    const localToken = readAnswer(JSON.parse(messages[0] ?? '{}')).result;
    harness.emit({
      jsonrpc: '2.0',
      method: 'transactionWatch_v1_watchEvent',
      params: { subscription: 'up-tx', result: { event: 'finalized' } },
    });

    // When the session unwatches its local token
    connection?.send(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'transactionWatch_v1_unwatch', params: [localToken] }),
    );

    // Then the answer is an error under the request id and nothing is unwatched upstream
    expect(JSON.parse(messages.at(-1) ?? '{}')).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      error: { message: 'Unknown subscription/token' },
    });
    expect(harness.sent.filter(message => message.method === 'transactionWatch_v1_unwatch')).toEqual([]);
  });

  it('As a session whose transaction is only included in a best block, I keep my watch and my disconnect unwatches it upstream', () => {
    // Given an answered watch
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const connection = manager.connectRemote('asset-hub', 'conn-a', () => undefined);
    connection?.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transactionWatch_v1_submitAndWatch', params: ['0x0102'] }),
    );
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-tx' });

    // When a non-final event arrives and the session leaves
    harness.emit({
      jsonrpc: '2.0',
      method: 'transactionWatch_v1_watchEvent',
      params: {
        subscription: 'up-tx',
        result: { event: 'bestChainBlockIncluded', block: { hash: '0xabc', index: 0 } },
      },
    });
    connection?.disconnect();

    // Then
    expect(
      harness.sent.filter(message => message.method === 'transactionWatch_v1_unwatch').map(message => message.params),
    ).toEqual([['up-tx']]);
  });

  it('As the last session leaving a follow before the node answers it, I leave no follow running upstream', () => {
    // Given a follow in flight
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const connection = manager.connectRemote('asset-hub', 'conn-a', () => undefined);
    connection?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] }));
    const follow = readUpstreamRequest(harness.sent[0]);

    // When the session leaves and only then the node answers
    connection?.disconnect();
    harness.emit({ jsonrpc: '2.0', id: follow.id, result: 'up-1' });

    // Then the follow is ended upstream
    expect(
      harness.sent.filter(message => message.method === 'chainHead_v1_unfollow').map(message => message.params),
    ).toEqual([['up-1']]);
  });

  it('As a session joining a follow whose first session left before the node answered, I get the follow the node answers', () => {
    // Given a follow in flight whose first session left
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', () => undefined);
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', message => messagesB.push(message));
    connectionA?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] }));
    connectionA?.disconnect();

    // When a second session follows and the node answers
    connectionB?.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'chainHead_v1_follow', params: [true] }));
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-1' });

    // Then one follow went upstream, it serves the second session, and nothing ended it
    expect(harness.sent.filter(message => message.method === 'chainHead_v1_follow')).toHaveLength(1);
    // An asymmetric matcher is typed any.
    expect(JSON.parse(messagesB[0] ?? '{}')).toEqual({ jsonrpc: '2.0', id: 2, result: expect.any(String) as string });
    expect(harness.sent.filter(message => message.method === 'chainHead_v1_unfollow')).toEqual([]);
  });
});

describe('broker warnings', () => {
  /** Builds a broker with one session, and returns a way for its upstream to answer a request nobody sent. */
  function createStrayResponder(): (id: string) => void {
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    broker.connect({ sessionId: 'session-a', onMessage: () => undefined });
    return id => {
      harness.emit({ jsonrpc: '2.0', id, result: null });
    };
  }

  it('As a dotli maintainer, I see an anomaly repeated on every message logged in full a few times, then only as a running count', () => {
    // Given a broker on a pool
    const harness = createProviderHarness();
    const pool = createManager(() => harness.provider);
    pool.connectRemote('asset-hub', 'conn-a', () => undefined);

    // When the upstream answers a thousand requests nobody sent
    const warnings = collectWarningsDuring(() => {
      for (let id = 0; id < 1000; id++) {
        harness.emit({ jsonrpc: '2.0', id: `stray-${String(id)}`, result: null });
      }
    });

    // Then the first three are logged in full, then only the count at each power of ten
    expect(warnings.slice(0, 3)).toEqual([
      '[dot.li broker] from upstream: response for unknown id=stray-0',
      '[dot.li broker] from upstream: response for unknown id=stray-1',
      '[dot.li broker] from upstream: response for unknown id=stray-2',
    ]);
    expect(warnings.slice(3).map(warning => /^\[dot\.li broker\] \w+: (\d+) so far$/.exec(warning)?.[1])).toEqual([
      '10',
      '100',
      '1000',
    ]);
  });

  it('As a dotli maintainer, I see two brokers that hit the same anomaly each log their own first few', () => {
    // Given two brokers, the first of which already hit an anomaly past its full logging
    const strayToFirst = createStrayResponder();
    const strayToSecond = createStrayResponder();
    collectWarningsDuring(() => {
      for (let id = 0; id < 5; id++) {
        strayToFirst(`first-${String(id)}`);
      }
    });

    // When the second broker hits the same anomaly
    const warnings = collectWarningsDuring(() => {
      strayToSecond('second-0');
    });

    // Then it is one full-form warning, as the second broker's first
    expect(warnings).toEqual([expect.stringMatching(/^\[dot\.li broker\] .*unknown id=second-0$/)]);
  });

  it('As a dotli maintainer, I see no warning when the node answers the unpins and unfollows the broker sends itself', () => {
    // Given a session that unpinned its first block, saw the chain finalize past it, and left
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    const messages: unknown[] = [];
    const connection = broker.connect({
      sessionId: 'a',
      onMessage: message => messages.push(message),
      wireMode: 'object',
    });
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-1' });
    const token = readAnswer(messages[0]).result;
    function emitFollowEvent(result: Record<string, unknown>): void {
      harness.emit({ jsonrpc: '2.0', method: 'chainHead_v1_followEvent', params: { subscription: 'up-1', result } });
    }
    emitFollowEvent({ event: 'initialized', finalizedBlockHashes: ['0xf0'] });
    connection.send({ jsonrpc: '2.0', id: 2, method: 'chainHead_v1_unpin', params: [token, ['0xf0']] });
    emitFollowEvent({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });
    emitFollowEvent({ event: 'finalized', finalizedBlockHashes: ['0xb1'], prunedBlockHashes: [] });
    connection.disconnect();
    const releases = harness.sent.filter(
      message => message.method === 'chainHead_v1_unpin' || message.method === 'chainHead_v1_unfollow',
    );

    // When the node answers them
    const warnings = collectWarningsDuring(() => {
      for (const release of releases) {
        harness.emit({ jsonrpc: '2.0', id: release.id ?? null, result: null });
      }
    });

    // Then
    expect(releases.map(release => release.method)).toEqual(['chainHead_v1_unpin', 'chainHead_v1_unfollow']);
    expect(warnings).toEqual([]);
  });

  it('As a dotli maintainer, I am warned when the node refuses a release the broker sent itself', () => {
    // Given a session that followed and left
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    const connection = broker.connect({ sessionId: 'a', onMessage: () => undefined, wireMode: 'object' });
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-1' });
    connection.disconnect();
    const unfollow = harness.sent.find(message => message.method === 'chainHead_v1_unfollow');

    // When the node refuses the unfollow
    const warnings = collectWarningsDuring(() => {
      harness.emit({
        jsonrpc: '2.0',
        id: unfollow?.id ?? null,
        error: { code: -32602, message: 'Invalid subscription' },
      });
    });

    // Then
    expect(warnings).toEqual([expect.stringMatching(/refused chainHead_v1_unfollow/)]);
  });

  it('As a dotli maintainer, I see no warning for follow events the node sends before it reads the unfollow the broker sent', () => {
    // Given a follow whose only session left before the node answered, so the broker unfollows it at the answer
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    const connection = broker.connect({ sessionId: 'a', onMessage: () => undefined, wireMode: 'object' });
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });
    connection.disconnect();
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-1' });

    // When the node still delivers events for that follow
    const warnings = collectWarningsDuring(() => {
      harness.emit({
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: { subscription: 'up-1', result: { event: 'initialized', finalizedBlockHashes: ['0xf0'] } },
      });
    });

    // Then
    expect(harness.sent.map(message => message.method)).toEqual(['chainHead_v1_follow', 'chainHead_v1_unfollow']);
    expect(warnings).toEqual([]);
  });

  it('As a dotli maintainer, I see no warning when many released watches still deliver events while a follow waits on its answer', () => {
    // Given a follow in flight, and a session that leaves with more watches than the early buffer keeps tokens for
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    broker.connect({ sessionId: 'a', onMessage: () => undefined, wireMode: 'object' }).send({
      jsonrpc: '2.0',
      id: 1,
      method: 'chainHead_v1_follow',
      params: [true],
    });
    const connection = broker.connect({ sessionId: 'b', onMessage: () => undefined, wireMode: 'object' });
    const tokens = Array.from({ length: 33 }, (_, index) => `up-tx-${String(index)}`);
    for (const [index, token] of tokens.entries()) {
      connection.send({ jsonrpc: '2.0', id: index, method: 'transactionWatch_v1_submitAndWatch', params: ['0x01'] });
      harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent.at(-1)).id, result: token });
    }
    connection.disconnect();

    // When the node still delivers an event for each watch before it reads the unwatches
    const warnings = collectWarningsDuring(() => {
      for (const token of tokens) {
        harness.emit({
          jsonrpc: '2.0',
          method: 'transactionWatch_v1_watchEvent',
          params: { subscription: token, result: { event: 'validated' } },
        });
      }
    });

    // Then each watch was unwatched upstream, and none of its late events was buffered or warned about
    expect(harness.sent.filter(message => message.method === 'transactionWatch_v1_unwatch')).toHaveLength(33);
    expect(warnings).toEqual([]);
  });

  it.each([
    {
      subscribe: 'transactionWatch_v1_submitAndWatch',
      params: ['0x01'],
      release: 'transactionWatch_v1_unwatch',
      releaseResult: null,
      event: 'transactionWatch_v1_watchEvent',
    },
    {
      subscribe: 'statement_subscribeStatement',
      params: [{ matchAll: ['0xtopic'] }],
      release: 'statement_unsubscribeStatement',
      releaseResult: true,
      event: 'statement_statement',
    },
  ])(
    'As a dApp that sends $release, I see no warning and no event the node sent before it read my release',
    ({ subscribe, params, release, releaseResult, event }) => {
      // Given a session that subscribed, then released its subscription, which the node has not answered yet
      const harness = createProviderHarness();
      const broker = createChainBroker({ provider: harness.provider });
      const messages: unknown[] = [];
      const connection = broker.connect({
        sessionId: 'a',
        onMessage: message => messages.push(message),
        wireMode: 'object',
      });
      connection.send({ jsonrpc: '2.0', id: 1, method: subscribe, params });
      harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent.at(-1)).id, result: 'up-sub' });
      const localToken = readAnswer(messages[0]).result;
      connection.send({ jsonrpc: '2.0', id: 2, method: release, params: [localToken] });
      const releaseId = readUpstreamRequest(harness.sent.at(-1)).id;

      // When the node still delivers an event it queued before it read the release
      const warnings = collectWarningsDuring(() => {
        harness.emit({
          jsonrpc: '2.0',
          method: event,
          params: { subscription: 'up-sub', result: { event: 'validated' } },
        });
      });
      harness.emit({ jsonrpc: '2.0', id: releaseId, result: releaseResult });

      // Then the event was dropped, and the session only got its two answers
      expect(warnings).toEqual([]);
      expect(messages).toEqual([
        { jsonrpc: '2.0', id: 1, result: localToken },
        { jsonrpc: '2.0', id: 2, result: releaseResult },
      ]);
    },
  );

  it('As a dApp that leaves while its unwatch is in flight, I leave no warning for an event the node sent before it read the unwatch', () => {
    // Given a session that watched a transaction, unwatched it and left before the node answered the unwatch
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    const messages: unknown[] = [];
    const connection = broker.connect({
      sessionId: 'a',
      onMessage: message => messages.push(message),
      wireMode: 'object',
    });
    connection.send({ jsonrpc: '2.0', id: 1, method: 'transactionWatch_v1_submitAndWatch', params: ['0x01'] });
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent.at(-1)).id, result: 'up-tx' });
    const localToken = readAnswer(messages[0]).result;
    connection.send({ jsonrpc: '2.0', id: 2, method: 'transactionWatch_v1_unwatch', params: [localToken] });
    const unwatchId = readUpstreamRequest(harness.sent.at(-1)).id;
    connection.disconnect();

    // When the node still delivers an event it queued before it read the unwatch
    const warnings = collectWarningsDuring(() => {
      harness.emit({
        jsonrpc: '2.0',
        method: 'transactionWatch_v1_watchEvent',
        params: { subscription: 'up-tx', result: { event: 'validated' } },
      });
      harness.emit({ jsonrpc: '2.0', id: unwatchId, result: null });
    });

    // Then
    expect(warnings).toEqual([]);
    expect(harness.sent.map(message => message.method)).toEqual([
      'transactionWatch_v1_submitAndWatch',
      'transactionWatch_v1_unwatch',
    ]);
  });

  it('As a dotli maintainer, I see no warning when many watches a session unwatched still deliver events while a follow waits on its answer', () => {
    // Given a follow in flight, and a session that unwatches more watches than the early buffer keeps tokens for
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    broker
      .connect({ sessionId: 'a', onMessage: () => undefined, wireMode: 'object' })
      .send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });
    const messages: unknown[] = [];
    const connection = broker.connect({
      sessionId: 'b',
      onMessage: message => messages.push(message),
      wireMode: 'object',
    });
    const tokens = Array.from({ length: 33 }, (_, index) => `up-tx-${String(index)}`);
    for (const [index, token] of tokens.entries()) {
      connection.send({ jsonrpc: '2.0', id: index, method: 'transactionWatch_v1_submitAndWatch', params: ['0x01'] });
      harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent.at(-1)).id, result: token });
    }
    for (const [index, message] of [...messages].entries()) {
      const localToken = readAnswer(message).result;
      connection.send({ jsonrpc: '2.0', id: 100 + index, method: 'transactionWatch_v1_unwatch', params: [localToken] });
    }

    // When the node still delivers an event for each watch before it reads the unwatches
    const warnings = collectWarningsDuring(() => {
      for (const token of tokens) {
        harness.emit({
          jsonrpc: '2.0',
          method: 'transactionWatch_v1_watchEvent',
          params: { subscription: token, result: { event: 'validated' } },
        });
      }
    });

    // Then none of the late events was buffered or warned about
    expect(warnings).toEqual([]);
  });
});

describe('createChainBroker halt', () => {
  /** Builds a broker on a fresh upstream, and a way to open object-wire sessions that log each message and halt. */
  function setUpBroker() {
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });

    /** Opens a session that logs `<id>:message` and `<id>:halt`, and throws from its handler when asked to. */
    function open(id: string, log: string[], { throwOnMessage = false }: { throwOnMessage?: boolean } = {}) {
      const messages: unknown[] = [];
      const connection = broker.connect({
        sessionId: id,
        onMessage: message => {
          messages.push(message);
          log.push(`${id}:message`);
          if (throwOnMessage) {
            throw new Error('consumer bug');
          }
        },
        wireMode: 'object',
        onHalt: () => {
          log.push(`${id}:halt`);
        },
      });
      return { send: connection.send, disconnect: connection.disconnect, messages };
    }

    return { broker, harness, open };
  }

  /** Opens a session whose follow the node answered with `upstreamToken`, with its messages and the log cleared. */
  function openFollowingSession({
    id,
    open,
    harness,
    log,
    upstreamToken,
  }: {
    id: string;
    open: ReturnType<typeof setUpBroker>['open'];
    harness: ReturnType<typeof createProviderHarness>;
    log: string[];
    upstreamToken: string;
  }): { messages: unknown[]; token: string } {
    const session = open(id, log);
    session.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });
    const upstream = readUpstreamRequest(harness.sent.at(-1));
    harness.emit({ jsonrpc: '2.0', id: upstream.id, result: upstreamToken });
    const ack = readAnswer(session.messages[0]);
    session.messages.length = 0;
    log.length = 0;
    return { messages: session.messages, token: ack.result };
  }

  it('As a dotli integrator, I halt a broker and a request in flight is answered under its client id before the session hears the halt', () => {
    // Given
    const { broker, harness, open } = setUpBroker();
    const log: string[] = [];
    const session = open('a', log);
    session.send({ jsonrpc: '2.0', id: 'req-1', method: 'chainHead_v1_header', params: ['tok', '0xabc'] });

    // When
    broker.halt(new Error('gone'));

    // Then
    expect(session.messages).toEqual([
      {
        jsonrpc: '2.0',
        id: 'req-1',
        error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
      },
    ]);
    expect(log).toEqual(['a:message', 'a:halt']);
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, I halt a broker and an established follow is stopped under its local token before the halt', () => {
    // Given
    const { broker, harness, open } = setUpBroker();
    const log: string[] = [];
    const follow = openFollowingSession({ id: 'a', open, harness, log, upstreamToken: 'up-1' });

    // When
    broker.halt();

    // Then
    expect(follow.messages).toEqual([
      {
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: { subscription: follow.token, result: { event: 'stop' } },
      },
    ]);
    expect(log).toEqual(['a:message', 'a:halt']);
  });

  it('As a dotli integrator, I halt a broker and a follow still in flight is answered with an error and no stop', () => {
    // Given
    const { broker, open } = setUpBroker();
    const log: string[] = [];
    const first = open('a', log);
    const second = open('b', log);
    first.send({ jsonrpc: '2.0', id: 11, method: 'chainHead_v1_follow', params: [true] });
    second.send({ jsonrpc: '2.0', id: 22, method: 'chainHead_v1_follow', params: [true] });

    // When
    broker.halt();

    // Then
    const createHaltedAnswer = (id: number): unknown => ({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
    });
    expect(first.messages).toEqual([createHaltedAnswer(11)]);
    expect(second.messages).toEqual([createHaltedAnswer(22)]);
  });

  it('As a dotli integrator, I halt a broker and each session hears only about its own requests and follows', () => {
    // Given
    const { broker, harness, open } = setUpBroker();
    const log: string[] = [];
    const following = openFollowingSession({ id: 'a', open, harness, log, upstreamToken: 'up-1' });
    const requesting = open('b', log);
    requesting.send({ jsonrpc: '2.0', id: 'b-req', method: 'chainHead_v1_header', params: ['tok', '0xabc'] });
    log.length = 0;

    // When
    broker.halt();

    // Then
    expect(following.messages).toEqual([
      {
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: { subscription: following.token, result: { event: 'stop' } },
      },
    ]);
    expect(requesting.messages).toEqual([
      {
        jsonrpc: '2.0',
        id: 'b-req',
        error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
      },
    ]);
  });

  it('As a dotli integrator, I halt a broker and a session whose handler throws is reported, still hears its halt and keeps no other from theirs', () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const errors: string[] = [];
    onTestFinished(
      bindLogSink({
        emit: ({ level, message }) => {
          if (level === 'error') {
            errors.push(message);
          }
        },
      }),
    );
    const { broker, open } = setUpBroker();
    const log: string[] = [];
    const broken = open('a', log, { throwOnMessage: true });
    const healthy = open('b', log);
    broken.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_header', params: ['tok', '0xabc'] });
    healthy.send({ jsonrpc: '2.0', id: 2, method: 'chainHead_v1_header', params: ['tok', '0xabc'] });

    // When
    const error = catchError(() => {
      broker.halt();
    });

    // Then
    expect(error).toBeUndefined();
    expect(healthy.messages).toHaveLength(1);
    expect(log).toContain('a:halt');
    expect(log).toContain('b:halt');
    expect(captured).toEqual([{ flow: 'protocol', step: 'listener', tags: { owner: 'chain_halt' } }]);
    expect(errors).toHaveLength(1);
    expect(metrics.counted('listener.delivery')).toEqual([{ outcome: 'error', reason: 'Error', owner: 'chain_halt' }]);
  });

  it('As a dotli integrator, I halt a broker and the release requests it sent itself are never answered', () => {
    // Given
    const { broker, harness, open } = setUpBroker();
    const log: string[] = [];
    const leaving = open('a', log);
    const staying = open('b', log);
    leaving.send({ jsonrpc: '2.0', id: 1, method: 'transactionWatch_v1_submitAndWatch', params: ['0xdead'] });
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'watch-1' });
    leaving.disconnect();
    staying.send({ jsonrpc: '2.0', id: 'b-req', method: 'chainHead_v1_header', params: ['tok', '0xabc'] });

    // When
    broker.halt();

    // Then
    expect(harness.sent.filter(m => m.method === 'transactionWatch_v1_unwatch')).toHaveLength(1);
    expect(staying.messages).toEqual([
      {
        jsonrpc: '2.0',
        id: 'b-req',
        error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
      },
    ]);
  });
});

describe('upstream follow stop', () => {
  type Event = {
    method?: string;
    id?: unknown;
    result?: unknown;
    params?: { subscription?: string; result?: { event?: string } };
  };

  /**
   * Connects a session that re-follows from inside the delivery of a `stop`, as papi's
   * chainHead client does. It gives up after 20 stops, so a broker that keeps
   * answering the re-follow with another stop ends instead of hanging.
   */
  function connectRefollowingSession(broker: ChainBroker): { messages: Event[]; countStops: () => number } {
    const messages: Event[] = [];
    let stops = 0;
    let nextId = 2;
    const connection = broker.connect({
      sessionId: 'a',
      onMessage: message => {
        // The object wire delivers the JSON-RPC message the broker built.
        const event = message as Event;
        messages.push(event);
        if (event.params?.result?.event === 'stop' && stops < 20) {
          stops += 1;
          connection.send({ jsonrpc: '2.0', id: nextId, method: 'chainHead_v1_follow', params: [true] });
          nextId += 1;
        }
      },
      wireMode: 'object',
      onHalt: () => undefined,
    });
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });
    return { messages, countStops: () => stops };
  }

  it('As a dApp user, I re-follow when the node stops my follow and it is followed afresh once, not looped on the dead one', () => {
    // Given a session following through the broker, with a snapshot cached
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    const session = connectRefollowingSession(broker);
    const first = readUpstreamRequest(harness.sent[0]);
    harness.emit({ jsonrpc: '2.0', id: first.id, result: 'up-1' });
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: 'up-1', result: { event: 'initialized', finalizedBlockHashes: ['0xaa'] } },
    });

    // When the node stops the follow, and the session re-follows at once
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: 'up-1', result: { event: 'stop' } },
    });

    // Then one stop, and the re-follow goes upstream as a fresh follow
    expect(session.countStops()).toBe(1);
    const follows = harness.sent.filter(m => m.method === 'chainHead_v1_follow');
    expect(follows).toHaveLength(2);
  });

  it('As a dApp user, I carry on under the fresh follow and its own token, and the stopped one hears nothing more', () => {
    // Given
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    const session = connectRefollowingSession(broker);
    harness.emit({ jsonrpc: '2.0', id: readUpstreamRequest(harness.sent[0]).id, result: 'up-1' });
    const oldToken = readAnswer(session.messages[0]).result;
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: 'up-1', result: { event: 'stop' } },
    });
    const refollow = readUpstreamRequest(harness.sent.filter(m => m.method === 'chainHead_v1_follow')[1]);

    // When
    harness.emit({ jsonrpc: '2.0', id: refollow.id, result: 'up-2' });
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: 'up-2', result: { event: 'bestBlockChanged', bestBlockHash: '0xbb' } },
    });

    // Then
    const ack = session.messages.find(m => m.id === 2);
    expect(ack?.result).toEqual(expect.any(String));
    expect(ack?.result).not.toBe(oldToken);
    const best = session.messages.filter(m => m.params?.result?.event === 'bestBlockChanged');
    expect(best.map(m => m.params?.subscription)).toEqual([ack?.result]);
  });
});

describe('upstream answers', () => {
  it('As a session that re-follows as soon as my follow is refused, I get one fresh upstream follow', () => {
    // Given a session that follows again from inside the refusal, as papi does
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    let retries = 0;
    const connection = broker.connect({
      sessionId: 'a',
      onMessage: raw => {
        if (isRecord(raw) && raw['error'] !== undefined && retries < 5) {
          retries += 1;
          connection.send({ jsonrpc: '2.0', id: 10 + retries, method: 'chainHead_v1_follow', params: [true] });
        }
      },
      wireMode: 'object',
    });
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });

    // When the node refuses the follow
    harness.emit({
      jsonrpc: '2.0',
      id: readUpstreamRequest(harness.sent[0]).id,
      error: { code: -32800, message: 'Too many follows' },
    });

    // Then the session retried once and the node received two follows
    expect(retries).toBe(1);
    expect(harness.sent.filter(message => message.method === 'chainHead_v1_follow')).toHaveLength(2);
  });

  it('As a session whose follow the node answers with garbled JSON, I hear an error and my next follow asks the node again', () => {
    // Given a follow sent upstream and a session listening for its answer
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    const messages: unknown[] = [];
    const connection = broker.connect({
      sessionId: 'a',
      onMessage: message => messages.push(message),
      wireMode: 'object',
    });
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });
    const follow = readUpstreamRequest(harness.sent[0]);

    // When the node answers the follow with garbled JSON and the session follows again
    // Garbled JSON is a string, which the provider's message type does not allow.
    harness.emit(`{"jsonrpc":"2.0","id":"${follow.id}","result":` as unknown as JsonRpcMessage);
    connection.send({ jsonrpc: '2.0', id: 2, method: 'chainHead_v1_follow', params: [true] });

    // Then the session hears an unparseable-response error and the second follow reaches the node
    expect(messages).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        // An asymmetric matcher is typed any.
        error: { code: -32603, message: expect.stringMatching(/^Upstream returned unparseable response: /) as string },
      },
    ]);
    expect(harness.sent.filter(message => message.method === 'chainHead_v1_follow')).toHaveLength(2);
  });

  it('As a session whose request the node answers with garbled JSON, I hear an error under my own id', () => {
    // Given a header request sent upstream under the session id
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    const messages: unknown[] = [];
    const connection = broker.connect({
      sessionId: 'a',
      onMessage: message => messages.push(message),
      wireMode: 'object',
    });
    connection.send({ jsonrpc: '2.0', id: 7, method: 'chainHead_v1_header', params: ['tok', '0xabc'] });
    const upstream = readUpstreamRequest(harness.sent[0]);

    // When the node answers the request with garbled JSON
    // Garbled JSON is a string, which the provider's message type does not allow.
    harness.emit(`{"jsonrpc":"2.0","id":"${upstream.id}","result":` as unknown as JsonRpcMessage);

    // Then the session hears the error under its own id
    expect(messages).toEqual([
      {
        jsonrpc: '2.0',
        id: 7,
        // An asymmetric matcher is typed any.
        error: { code: -32603, message: expect.stringMatching(/^Upstream returned unparseable response: /) as string },
      },
    ]);
  });
});

describe('createChainBroker local tokens', () => {
  it('As a session that reconnects after the broker closed every session, I get a local token that continues the count instead of repeating an old one', () => {
    // Given a session that got its follow token before every session was closed
    const harness = createProviderHarness();
    const broker = createChainBroker({ provider: harness.provider });
    const messages: unknown[] = [];
    const first = broker.connect({ sessionId: 'a', onMessage: message => messages.push(message), wireMode: 'object' });
    first.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });
    harness.emit({ jsonrpc: '2.0', id: must(harness.sent.at(-1)?.id, 'first follow id'), result: 'up-1' });
    broker.disconnectAll();

    // When the same session connects again and follows
    const second = broker.connect({ sessionId: 'a', onMessage: message => messages.push(message), wireMode: 'object' });
    second.send({ jsonrpc: '2.0', id: 2, method: 'chainHead_v1_follow', params: [true] });
    harness.emit({ jsonrpc: '2.0', id: must(harness.sent.at(-1)?.id, 'second follow id'), result: 'up-2' });

    // Then
    expect(messages).toEqual([
      { jsonrpc: '2.0', id: 1, result: 'follow:0:a' },
      { jsonrpc: '2.0', id: 2, result: 'follow:1:a' },
    ]);
  });
});
