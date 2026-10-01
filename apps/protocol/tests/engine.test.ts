// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, type Mock } from 'vitest';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import type { ProtocolEnvelope, ProtocolRequestEnvelope, ProtocolRequestMap } from '@dotli/protocol';
import type { ChainTransportHooks } from '@dotli/resolver';
import { createEngine, type EngineOptions, type ProtocolEngine } from '../src/engine.js';

const ORIGIN_A = 'https://a.example';

interface TransportRecord {
  genesisHash: string;
  hooks: ChainTransportHooks | undefined;
  sent: JsonRpcRequest[];
  emit: (message: JsonRpcMessage) => void;
  disconnect: Mock<() => void>;
}

function createTransports(): {
  createChainProvider: (genesisHash: string, hooks?: ChainTransportHooks) => JsonRpcProvider | null;
  built: TransportRecord[];
} {
  const built: TransportRecord[] = [];
  const createChainProvider = (genesisHash: string, hooks?: ChainTransportHooks): JsonRpcProvider => {
    let listener: ((message: JsonRpcMessage) => void) | null = null;
    const record: TransportRecord = {
      genesisHash,
      hooks,
      sent: [],
      emit(message) {
        listener?.(message);
      },
      disconnect: vi.fn<() => void>(),
    };
    built.push(record);
    return (onMessage): JsonRpcConnection => {
      listener = onMessage;
      return {
        send(message) {
          record.sent.push(message);
        },
        disconnect: record.disconnect,
      };
    };
  };
  return { createChainProvider, built };
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

let requestCounter = 0;

/** Sends one request; every envelope the engine answers with lands in the returned array, including later ones. */
async function call<M extends keyof ProtocolRequestMap>(
  engine: ProtocolEngine,
  method: M,
  payload: ProtocolRequestMap[M],
  origin = ORIGIN_A,
): Promise<ProtocolEnvelope[]> {
  const out: ProtocolEnvelope[] = [];
  requestCounter += 1;
  const request = {
    namespace: 'dotli:protocol',
    kind: 'request',
    id: `r${String(requestCounter)}`,
    method,
    payload,
  } as ProtocolRequestEnvelope<M>;
  await engine.handleRequest(request, origin, envelope => out.push(envelope));
  return out;
}

function setup(extra: Partial<EngineOptions> = {}): { engine: ProtocolEngine; built: TransportRecord[] } {
  const { createChainProvider, built } = createTransports();
  const engine = createEngine({ createChainProvider, isChainSupported: () => true, ...extra });
  return { engine, built };
}

describe('createEngine chain connections', () => {
  it('As a dotli integrator, a remote chain connection carries requests and answers', async () => {
    // Given
    const { engine, built } = setup();
    const connected = await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });

    // When
    await call(engine, 'chainSend', {
      connectionId: 'c1',
      message: JSON.stringify({ jsonrpc: '2.0', id: 'q1', method: 'chainSpec_v1_genesisHash', params: [] }),
    });
    const transport = must(built[0], 'transport');
    transport.emit({ jsonrpc: '2.0', id: must(transport.sent[0], 'request').id ?? null, result: '0xaa' });

    // Then
    expect(connected[0]).toMatchObject({ kind: 'response', ok: true, result: true });
    expect(connected[1]).toMatchObject({ kind: 'chain-message', connectionId: 'c1' });
    expect(JSON.parse((connected[1] as { message: string }).message)).toEqual({
      jsonrpc: '2.0',
      id: 'q1',
      result: '0xaa',
    });
  });

  it('As a dotli integrator, chainSend on a connection that does not exist fails', async () => {
    // Given
    const { engine } = setup();

    // When
    const send = call(engine, 'chainSend', { connectionId: 'nope', message: '{}' });

    // Then
    await expect(send).rejects.toThrow('Unknown chain connection: nope');
  });

  it('As a dotli integrator, chainDisconnect on a connection that does not exist succeeds', async () => {
    // Given
    const { engine } = setup();

    // When
    const out = await call(engine, 'chainDisconnect', { connectionId: 'nope' });

    // Then
    expect(out[0]).toMatchObject({ kind: 'response', ok: true, result: true });
  });
});
