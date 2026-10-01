// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, type Mock } from 'vitest';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { createChainPool, type ProtocolEnvelope } from '@dotli/protocol';
import type { ChainTransportHooks } from '@dotli/resolver';
import { createWorkerChainSessions, type WorkerChainSessions } from '../src/worker-chains.js';

const ORIGIN_A = 'https://a.example';

interface TransportRecord {
  hooks: ChainTransportHooks;
  sent: JsonRpcRequest[];
  emit: (message: JsonRpcMessage) => void;
  disconnect: Mock<() => void>;
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

function setup(): {
  sessions: WorkerChainSessions;
  built: TransportRecord[];
  posted: { port: MessagePort; envelope: ProtocolEnvelope }[];
  portA: MessagePort;
  portB: MessagePort;
} {
  const built: TransportRecord[] = [];
  const createTransport = (_genesisHash: string, hooks: ChainTransportHooks): JsonRpcProvider => {
    let listener: ((message: JsonRpcMessage) => void) | null = null;
    const record: TransportRecord = {
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
  const pool = createChainPool({ createTransport, destroyDelay: 0 });
  const posted: { port: MessagePort; envelope: ProtocolEnvelope }[] = [];
  const sessions = createWorkerChainSessions(
    pool,
    () => true,
    (port, envelope) => posted.push({ port, envelope }),
    () => undefined,
  );
  return { sessions, built, posted, portA: {} as MessagePort, portB: {} as MessagePort };
}

const genesisRequest = (id: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'chainSpec_v1_genesisHash', params: [] });

describe('createWorkerChainSessions', () => {
  it('As a dotli user on the shared light client, my chain answers reach the tab that asked', () => {
    // Given
    const { sessions, built, posted, portA } = setup();
    sessions.connect(portA, ORIGIN_A, '0xaa', 'c1');

    // When
    sessions.send(ORIGIN_A, 'c1', genesisRequest('q1'));
    const transport = must(built[0], 'transport');
    transport.emit({ jsonrpc: '2.0', id: must(transport.sent[0], 'request').id ?? null, result: '0xaa' });

    // Then
    expect(posted).toHaveLength(1);
    expect(must(posted[0], 'post').port).toBe(portA);
    expect(must(posted[0], 'post').envelope).toMatchObject({ kind: 'chain-message', connectionId: 'c1' });
  });

  it("As a dotli user on the shared light client, closing a tab releases only that tab's connections", () => {
    // Given
    const { sessions, built, portA, portB } = setup();
    sessions.connect(portA, ORIGIN_A, '0xaa', 'c1');
    sessions.connect(portB, ORIGIN_A, '0xbb', 'c2');

    // When
    const cleaned = sessions.removePort(portA);

    // Then
    expect(cleaned).toBe(1);
    expect(sessions.size).toBe(1);
    expect(must(built[0], 'first chain').disconnect).toHaveBeenCalledTimes(1);
    expect(must(built[1], 'second chain').disconnect).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, chainSend on a connection that does not exist fails', () => {
    // Given
    const { sessions } = setup();

    // When
    const send = (): void => {
      sessions.send(ORIGIN_A, 'nope', '{}');
    };

    // Then
    expect(send).toThrow('Unknown chain connection: nope');
  });
});
