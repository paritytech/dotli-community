// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { bindLogSink } from '@dotli/shared';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { ChainBroker } from './broker.js';
import { createChainPool } from './chain-pool.js';

/** The broker suites' manager: a pool that keeps its chains, with transports built without hooks. */
function createManager(
  createProvider: (genesisHash: string) => JsonRpcProvider | null,
): ReturnType<typeof createChainPool> {
  return createChainPool({ createTransport: genesisHash => createProvider(genesisHash), destroyDelay: Infinity });
}

function createProviderHarness(): {
  provider: JsonRpcProvider;
  sent: JsonRpcRequest[];
  disconnect: ReturnType<typeof vi.fn>;
  emit: (message: JsonRpcMessage) => void;
} {
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

describe('chain pool brokering', () => {
  it('As a session sharing a chain with another, I send a request under my own id and get my own response back', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(genesisHash => (genesisHash === 'asset-hub' ? harness.provider : null));

    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', message => {
      messagesA.push(message);
    });
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', message => {
      messagesB.push(message);
    });

    expect(connectionA).not.toBeNull();
    expect(connectionB).not.toBeNull();

    // When
    connectionA?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'chainHead_v1_header',
        params: ['token-a', '0xabc'],
      }),
    );
    connectionB?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'chainHead_v1_header',
        params: ['token-b', '0xdef'],
      }),
    );

    const upstreamA = harness.sent[0] as { id: string };
    const upstreamB = harness.sent[1] as { id: string };

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
    const upstream = harness.sent[0] as { id: string };
    harness.emit({ jsonrpc: '2.0', id: upstream.id, result: 'up-a' });

    // Then
    const localTokenA = (JSON.parse(messagesA[0] ?? '{}') as { result: string }).result;
    const localTokenB = (JSON.parse(messagesB[0] ?? '{}') as { result: string }).result;
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

    const upstreamRequest = harness.sent[0] as { id: string };
    harness.emit({ jsonrpc: '2.0', id: upstreamRequest.id, result: 'up-a' });

    // When
    connection?.disconnect();

    // Then
    const release = harness.sent[1] as { method: string; params: string[] };
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

    // When
    connection?.disconnect();

    // Then
    const release = harness.sent[1] as { method: string; params: string[] };
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
    const upstreamRequest = harness.sent[0] as { id: string };
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
      id: (harness.sent[0] as { id: string }).id,
      result: 'up-stmt',
    });
    harness.emit({
      jsonrpc: '2.0',
      id: (harness.sent[1] as { id: string }).id,
      result: 'up-stmt',
    });

    // Then
    const localTokenA = (JSON.parse(messagesA[0] ?? '{}') as { result: string }).result;
    const localTokenB = (JSON.parse(messagesB[0] ?? '{}') as { result: string }).result;
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
    expect((releases[0]?.params as unknown[])[0]).toBe('up-stmt');
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
    const release = harness.sent.at(-1) as {
      id: string;
      method: string;
      params: string[];
    };
    expect(release.method).toBe('statement_unsubscribeStatement');
    expect(release.params[0]).toBe('up-stmt');

    // When
    harness.emit({
      jsonrpc: '2.0',
      id: release.id,
      result: true,
    } as JsonRpcMessage);

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

  it('As a dApp user sharing a new follow, a session that unpins as it hears initialized leaves my blocks pinned', () => {
    // Given: A releases the older finalized blocks inside its own delivery, as polkadot-api does
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const messagesB: string[] = [];
    let tokenA = '';
    const connectionA = manager.connectRemote('bulletin', 'conn-a', raw => {
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
    harness.emit({ jsonrpc: '2.0', id: (harness.sent[0] as { id: string }).id, result: 'up-a' });

    // When
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: {
        subscription: 'up-a',
        result: { event: 'initialized', finalizedBlockHashes: ['0xf0', '0xf1', '0xf2'], finalizedBlockRuntime: null },
      },
    } as unknown as JsonRpcMessage);

    // Then
    const initializedB = (JSON.parse(messagesB[1] ?? '{}') as { params: { result: Record<string, unknown> } }).params
      .result;
    expect(initializedB['finalizedBlockHashes']).toEqual(['0xf0', '0xf1', '0xf2']);
    expect(harness.sent.filter(message => message.method === 'chainHead_v1_unpin')).toEqual([]);
  });

  it('As a dApp user, joining a follow another session holds replays only blocks still pinned upstream', () => {
    // Given: session A follows, sees two blocks finalized and a third on top,
    // then unpins what it no longer needs, as papi does
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', message => messagesA.push(message));
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', message => messagesB.push(message));
    connectionA?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] }));
    harness.emit({ jsonrpc: '2.0', id: (harness.sent[0] as { id: string }).id, result: 'up-a' });
    const localTokenA = (JSON.parse(messagesA[0] ?? '{}') as { result: string }).result;
    const event = (result: Record<string, unknown>): void => {
      harness.emit({ jsonrpc: '2.0', method: 'chainHead_v1_followEvent', params: { subscription: 'up-a', result } });
    };
    event({ event: 'initialized', finalizedBlockHashes: ['0xf0'], finalizedBlockRuntime: { type: 'valid' } });
    event({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });
    event({ event: 'newBlock', blockHash: '0xb2', parentBlockHash: '0xb1' });
    event({ event: 'finalized', finalizedBlockHashes: ['0xb1', '0xb2'], prunedBlockHashes: [] });
    event({ event: 'newBlock', blockHash: '0xb3', parentBlockHash: '0xb2' });
    event({ event: 'bestBlockChanged', bestBlockHash: '0xb3' });
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

    // Then: B starts from the newest finalized block, and every block it hears of is still pinned
    const unpinned = harness.sent
      .filter(message => message.method === 'chainHead_v1_unpin')
      .flatMap(message => (message.params as [string, string[]])[1]);
    const replay = messagesB
      .slice(1)
      .map(message => (JSON.parse(message) as { params: { result: Record<string, unknown> } }).params.result);
    expect(replay).toEqual([
      { event: 'initialized', finalizedBlockHashes: ['0xb2'], finalizedBlockRuntime: { type: 'valid' } },
      { event: 'newBlock', blockHash: '0xb3', parentBlockHash: '0xb2' },
      { event: 'bestBlockChanged', bestBlockHash: '0xb3' },
    ]);
    expect(unpinned).not.toContain('0xb2');
    expect(unpinned).not.toContain('0xb3');
  });

  it('As a dApp user, joining a follow after a runtime upgrade was finalized replays the upgraded runtime', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const messagesB: string[] = [];
    const connectionA = manager.connectRemote('asset-hub', 'conn-a', () => undefined);
    const connectionB = manager.connectRemote('asset-hub', 'conn-b', message => messagesB.push(message));
    connectionA?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] }));
    harness.emit({ jsonrpc: '2.0', id: (harness.sent[0] as { id: string }).id, result: 'up-a' });
    const event = (result: Record<string, unknown>): void => {
      harness.emit({ jsonrpc: '2.0', method: 'chainHead_v1_followEvent', params: { subscription: 'up-a', result } });
    };
    event({ event: 'initialized', finalizedBlockHashes: ['0xf0'], finalizedBlockRuntime: { type: 'valid', spec: 1 } });
    event({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0', newRuntime: { type: 'valid', spec: 2 } });
    event({ event: 'finalized', finalizedBlockHashes: ['0xb1'], prunedBlockHashes: [] });

    // When
    connectionB?.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'chainHead_v1_follow', params: [true] }));

    // Then
    expect((JSON.parse(messagesB[1] ?? '{}') as { params: { result: unknown } }).params.result).toEqual({
      event: 'initialized',
      finalizedBlockHashes: ['0xb1'],
      finalizedBlockRuntime: { type: 'valid', spec: 2 },
    });
  });

  it('As the host page, I get a local provider on the same upstream as remote sessions and each gets its own answers', () => {
    // Given
    const harness = createProviderHarness();
    const manager = createManager(() => harness.provider);
    const localProvider = manager.getLocalProvider('asset-hub');
    const remoteMessages: string[] = [];

    expect(localProvider).not.toBeNull();

    // `getLocalProvider` uses the object wire. `connectRemote` uses the string wire.
    const localMessages: JsonRpcMessage[] = [];
    const localConnection = localProvider?.(message => {
      localMessages.push(message);
    });
    const remoteConnection = manager.connectRemote('asset-hub', 'conn-a', message => {
      remoteMessages.push(message);
    });

    // When
    localConnection?.send({
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

    const localUpstream = harness.sent[0] as { id: string };
    const remoteUpstream = harness.sent[1] as { id: string };

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
    const upstreamA = harness.sent[0] as { id: string };
    const upstreamB = harness.sent[1] as { id: string };
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
    const responseA = messagesA[0] as { id: string; result: string };
    const responseB = messagesB[0] as { id: string; result: string };
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
    const upstream = harness.sent[0] as { id: string };
    harness.emit({ jsonrpc: '2.0', id: upstream.id, result: 'up-a' });

    // Then
    const localTokenA = (JSON.parse(messagesA[0] ?? '{}') as { result: string }).result;
    const localTokenB = (JSON.parse(messagesB[0] ?? '{}') as { result: string }).result;
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

    // When
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
    expect((unpins[0]?.params as unknown[])[0]).toBe('up-a');
    expect((unpins[0]?.params as unknown[])[1]).toEqual(['0xblock']);
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
      id: (harness.sent[0] as { id: string }).id,
      result: 'up-a',
    });
    const localTokenB = (JSON.parse(messagesB[0] ?? '{}') as { result: string }).result;

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
    expect((unpins[0]?.params as unknown[])[0]).toBe('up-a');
    expect((unpins[0]?.params as unknown[])[1]).toEqual(['0xblock']);
  });
});

describe('broker warnings', () => {
  /** Collects the warnings logged while `run` runs, then puts back the sink bound before. */
  function warningsDuring(run: () => void): string[] {
    const warnings: string[] = [];
    const restore = bindLogSink({
      emit: (level, message) => {
        if (level === 'warn') {
          warnings.push(message);
        }
      },
    });
    try {
      run();
    } finally {
      restore();
    }
    return warnings;
  }

  /** A broker with one session on a fresh upstream, and a way for that upstream to answer a request nobody sent. */
  function brokerWithStrayResponses(): (id: string) => void {
    const harness = createProviderHarness();
    const broker = new ChainBroker(harness.provider, () => undefined);
    broker.connect('session-a', () => undefined);
    return id => {
      harness.emit({ jsonrpc: '2.0', id, result: null });
    };
  }

  it('As a dotli maintainer, an anomaly repeated on every message logs its first few, then only a running count', () => {
    // Given a broker on a pool
    const harness = createProviderHarness();
    const pool = createManager(() => harness.provider);
    pool.connectRemote('asset-hub', 'conn-a', () => undefined);

    // When the upstream answers a thousand requests nobody sent
    const warnings = warningsDuring(() => {
      for (let id = 0; id < 1000; id++) {
        harness.emit({ jsonrpc: '2.0', id: `stray-${String(id)}`, result: null });
      }
    });

    // Then the first three are logged in full, then only the count at each power of ten
    expect(warnings).toEqual([
      '[dot.li broker] ← upstream response for unknown id=stray-0',
      '[dot.li broker] ← upstream response for unknown id=stray-1',
      '[dot.li broker] ← upstream response for unknown id=stray-2',
      '[dot.li broker] response_unknown_id: 10 so far',
      '[dot.li broker] response_unknown_id: 100 so far',
      '[dot.li broker] response_unknown_id: 1000 so far',
    ]);
  });

  it('As a dotli maintainer, two brokers that hit the same anomaly each log their own first few', () => {
    // Given two brokers, the first of which already hit an anomaly past its full logging
    const strayToFirst = brokerWithStrayResponses();
    const strayToSecond = brokerWithStrayResponses();
    warningsDuring(() => {
      for (let id = 0; id < 5; id++) {
        strayToFirst(`first-${String(id)}`);
      }
    });

    // When the second broker hits the same anomaly
    const warnings = warningsDuring(() => {
      strayToSecond('second-0');
    });

    // Then it is logged in full, as the second broker's first
    expect(warnings).toEqual(['[dot.li broker] ← upstream response for unknown id=second-0']);
  });
});

describe('ChainBroker.halt', () => {
  function setup(): {
    broker: ChainBroker;
    harness: ReturnType<typeof createProviderHarness>;
    open: (
      id: string,
      log: string[],
      throwOnMessage?: boolean,
    ) => { send: (message: unknown) => void; disconnect: () => void; messages: unknown[] };
  } {
    const harness = createProviderHarness();
    const broker = new ChainBroker(harness.provider, () => undefined);
    const open: ReturnType<typeof setup>['open'] = (id, log, throwOnMessage = false) => {
      const messages: unknown[] = [];
      const connection = broker.connect(
        id,
        message => {
          messages.push(message);
          log.push(`${id}:message`);
          if (throwOnMessage) {
            throw new Error('consumer bug');
          }
        },
        'object',
        () => {
          log.push(`${id}:halt`);
        },
      );
      return { send: connection.send, disconnect: connection.disconnect, messages };
    };
    return { broker, harness, open };
  }

  function followedSession(
    id: string,
    open: ReturnType<typeof setup>['open'],
    harness: ReturnType<typeof setup>['harness'],
    log: string[],
    upstreamToken: string,
  ): { messages: unknown[]; token: string } {
    const session = open(id, log);
    session.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });
    const upstream = harness.sent[harness.sent.length - 1] as { id: string };
    harness.emit({ jsonrpc: '2.0', id: upstream.id, result: upstreamToken });
    const ack = session.messages[0] as { result: string };
    session.messages.length = 0;
    log.length = 0;
    return { messages: session.messages, token: ack.result };
  }

  it('As a dotli integrator, a halt answers a request in flight under its client id before the session hears the halt', () => {
    // Given
    const { broker, harness, open } = setup();
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

  it('As a dotli integrator, a halt stops an established follow under its local token before the halt', () => {
    // Given
    const { broker, harness, open } = setup();
    const log: string[] = [];
    const follow = followedSession('a', open, harness, log, 'up-1');

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

  it('As a dotli integrator, a halt answers a follow still in flight with an error and no stop', () => {
    // Given
    const { broker, open } = setup();
    const log: string[] = [];
    const first = open('a', log);
    const second = open('b', log);
    first.send({ jsonrpc: '2.0', id: 11, method: 'chainHead_v1_follow', params: [true] });
    second.send({ jsonrpc: '2.0', id: 22, method: 'chainHead_v1_follow', params: [true] });

    // When
    broker.halt();

    // Then
    const error = (id: number): unknown => ({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
    });
    expect(first.messages).toEqual([error(11)]);
    expect(second.messages).toEqual([error(22)]);
  });

  it('As a dotli integrator, a halt tells each session only about its own requests and follows', () => {
    // Given
    const { broker, harness, open } = setup();
    const log: string[] = [];
    const a = followedSession('a', open, harness, log, 'up-1');
    const b = open('b', log);
    b.send({ jsonrpc: '2.0', id: 'b-req', method: 'chainHead_v1_header', params: ['tok', '0xabc'] });
    log.length = 0;

    // When
    broker.halt();

    // Then
    expect(a.messages).toEqual([
      {
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: { subscription: a.token, result: { event: 'stop' } },
      },
    ]);
    expect(b.messages).toEqual([
      {
        jsonrpc: '2.0',
        id: 'b-req',
        error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
      },
    ]);
  });

  it('As a dotli integrator, a session whose handler throws is reported, still hears its halt and does not keep the others from theirs', () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const errors: string[] = [];
    onTestFinished(
      bindLogSink({
        emit: (level, message) => {
          if (level === 'error') {
            errors.push(message);
          }
        },
      }),
    );
    const { broker, open } = setup();
    const log: string[] = [];
    const broken = open('a', log, true);
    const healthy = open('b', log);
    broken.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_header', params: ['tok', '0xabc'] });
    healthy.send({ jsonrpc: '2.0', id: 2, method: 'chainHead_v1_header', params: ['tok', '0xabc'] });

    // When
    const halt = (): void => {
      broker.halt();
    };

    // Then
    expect(halt).not.toThrow();
    expect(healthy.messages).toHaveLength(1);
    expect(log).toContain('a:halt');
    expect(log).toContain('b:halt');
    expect(captured).not.toHaveLength(0);
    expect(captured.every(capture => capture.tags?.['owner'] === 'chain_halt')).toBe(true);
    expect(errors).toHaveLength(captured.length);
    expect(metrics.counted('listener.delivery')).toHaveLength(captured.length);
  });

  it('As a dotli integrator, the release requests the broker sends itself are never answered on a halt', () => {
    // Given
    const { broker, harness, open } = setup();
    const log: string[] = [];
    const leaving = open('a', log);
    const staying = open('b', log);
    leaving.send({ jsonrpc: '2.0', id: 1, method: 'transactionWatch_v1_submitAndWatch', params: ['0xdead'] });
    harness.emit({ jsonrpc: '2.0', id: (harness.sent[0] as { id: string }).id, result: 'watch-1' });
    leaving.disconnect();
    staying.send({ jsonrpc: '2.0', id: 'b-req', method: 'chainHead_v1_header', params: ['tok', '0xabc'] });

    // When
    broker.halt();

    // Then
    expect(harness.sent.some(m => String(m.id).startsWith('broker-release:'))).toBe(true);
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
  interface Event {
    method?: string;
    id?: unknown;
    result?: unknown;
    params?: { subscription?: string; result?: { event?: string } };
  }

  /**
   * A session that re-follows from inside the delivery of a `stop`, as papi's
   * chainHead client does. It gives up after 20 stops, so a broker that keeps
   * answering the re-follow with another stop ends instead of hanging.
   */
  function refollowingSession(broker: ChainBroker): { messages: Event[]; stops: () => number } {
    const messages: Event[] = [];
    let stops = 0;
    let nextId = 2;
    const connection = broker.connect(
      'a',
      message => {
        const event = message as Event;
        messages.push(event);
        if (event.params?.result?.event === 'stop' && stops < 20) {
          stops += 1;
          connection.send({ jsonrpc: '2.0', id: nextId, method: 'chainHead_v1_follow', params: [true] });
          nextId += 1;
        }
      },
      'object',
      () => undefined,
    );
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });
    return { messages, stops: () => stops };
  }

  it('As a dApp user, a follow the node stops is followed afresh once, not looped on the dead one', () => {
    // Given: a session following through the broker, with a snapshot cached.
    const harness = createProviderHarness();
    const broker = new ChainBroker(harness.provider, () => undefined);
    const session = refollowingSession(broker);
    const first = harness.sent[0] as { id: string };
    harness.emit({ jsonrpc: '2.0', id: first.id, result: 'up-1' });
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: 'up-1', result: { event: 'initialized', finalizedBlockHashes: ['0xaa'] } },
    });

    // When: the node stops the follow, and the session re-follows at once.
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: 'up-1', result: { event: 'stop' } },
    });

    // Then: one stop, and the re-follow goes upstream as a fresh follow.
    expect(session.stops()).toBe(1);
    const follows = harness.sent.filter(m => m.method === 'chainHead_v1_follow');
    expect(follows).toHaveLength(2);
  });

  it('As a dApp user, the fresh follow carries on under its own token and the stopped one hears nothing more', () => {
    // Given
    const harness = createProviderHarness();
    const broker = new ChainBroker(harness.provider, () => undefined);
    const session = refollowingSession(broker);
    harness.emit({ jsonrpc: '2.0', id: (harness.sent[0] as { id: string }).id, result: 'up-1' });
    const oldToken = (session.messages[0] as { result: string }).result;
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: 'up-1', result: { event: 'stop' } },
    });
    const refollow = harness.sent.filter(m => m.method === 'chainHead_v1_follow')[1] as { id: string };

    // When
    harness.emit({ jsonrpc: '2.0', id: refollow.id, result: 'up-2' });
    harness.emit({
      jsonrpc: '2.0',
      method: 'chainHead_v1_followEvent',
      params: { subscription: 'up-2', result: { event: 'bestBlockChanged', bestBlockHash: '0xbb' } },
    });

    // Then
    const ack = session.messages.find(m => m.id === 2) as { result: string } | undefined;
    expect(ack?.result).toEqual(expect.any(String));
    expect(ack?.result).not.toBe(oldToken);
    const best = session.messages.filter(m => m.params?.result?.event === 'bestBlockChanged');
    expect(best.map(m => m.params?.subscription)).toEqual([ack?.result]);
  });
});
