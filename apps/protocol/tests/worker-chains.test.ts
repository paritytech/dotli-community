// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { createChainPool, type ProtocolEnvelope } from '@dotli/protocol';
import type { ChainTransportHooks } from '@dotli/resolver';
import { log } from '@dotli/shared';
import { MAX_CHAIN_CONNECTIONS, createWorkerChainSessions, type WorkerChainSessions } from '../src/worker-chains.js';

const ORIGIN_A = 'https://a.example';
const ORIGIN_B = 'https://b.example';

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

function setup(onSend?: (sessions: () => WorkerChainSessions, port: MessagePort, envelope: ProtocolEnvelope) => void): {
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
    (port, envelope) => {
      posted.push({ port, envelope });
      onSend?.(() => sessions, port, envelope);
    },
    () => undefined,
  );
  return { sessions, built, posted, portA: {} as MessagePort, portB: {} as MessagePort };
}

const genesisRequest = (id: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'chainSpec_v1_genesisHash', params: [] });

beforeEach(() => {
  vi.spyOn(log, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

function haltTransport(transport: TransportRecord): void {
  transport.hooks.onStatus('disconnected');
  transport.hooks.onHalt(new Error('chain died'));
}

describe('createWorkerChainSessions halts and origins', () => {
  it('As a dotli user on the shared light client, a dead chain answers my tab, then says the connection halted', () => {
    // Given
    const { sessions, built, posted, portA } = setup();
    sessions.connect(portA, ORIGIN_A, '0xaa', 'c1');
    sessions.send(ORIGIN_A, 'c1', genesisRequest('q1'));

    // When
    haltTransport(must(built[0], 'transport'));

    // Then
    expect(posted.map(p => p.port)).toEqual([portA, portA]);
    expect(posted.map(p => p.envelope)).toEqual([
      {
        namespace: 'dotli:protocol',
        kind: 'chain-message',
        connectionId: 'c1',
        message: JSON.stringify({
          jsonrpc: '2.0',
          id: 'q1',
          error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
        }),
      },
      { namespace: 'dotli:protocol', kind: 'chain-halt', connectionId: 'c1' },
    ]);
    expect(sessions.size).toBe(0);
  });

  it('As a dotli user on the shared light client, closing a tab after its chain died releases only what is left', () => {
    // Given
    const { sessions, built, portA } = setup();
    sessions.connect(portA, ORIGIN_A, '0xaa', 'c1');
    sessions.connect(portA, ORIGIN_A, '0xbb', 'c2');
    haltTransport(must(built[0], 'first chain'));
    const firstDisconnects = must(built[0], 'first chain').disconnect.mock.calls.length;

    // When
    const cleaned = sessions.removePort(portA);

    // Then
    expect(cleaned).toBe(1);
    expect(must(built[0], 'first chain').disconnect.mock.calls.length).toBe(firstDisconnects);
    expect(must(built[1], 'second chain').disconnect).toHaveBeenCalledTimes(1);
  });

  it("As a dotli user on the shared light client, another site cannot send on or close my tab's connection", () => {
    // Given
    const { sessions, built, portA } = setup();
    sessions.connect(portA, ORIGIN_A, '0xaa', 'c1');

    // When
    const send = (): void => {
      sessions.send(ORIGIN_B, 'c1', genesisRequest('q1'));
    };
    sessions.disconnect(ORIGIN_B, 'c1');

    // Then
    expect(send).toThrow('Unknown chain connection: c1');
    expect(sessions.size).toBe(1);
    sessions.send(ORIGIN_A, 'c1', genesisRequest('q2'));
    expect(must(built[0], 'transport').sent).toHaveLength(1);
  });

  it('As a dotli user on the shared light client, two sites may both call their connection c1', () => {
    // Given
    const { sessions, built, portA, portB } = setup();
    sessions.connect(portA, ORIGIN_A, '0xaa', 'c1');
    sessions.connect(portB, ORIGIN_B, '0xaa', 'c1');

    // When
    sessions.disconnect(ORIGIN_A, 'c1');

    // Then
    expect(sessions.size).toBe(1);
    sessions.send(ORIGIN_B, 'c1', genesisRequest('q1'));
    expect(must(built[0], 'transport').sent).toHaveLength(1);
  });

  it('As a dotli user on the shared light client, reusing a connection id on my site is refused before anything opens', () => {
    // Given
    const { sessions, built, portA } = setup();
    sessions.connect(portA, ORIGIN_A, '0xaa', 'c1');

    // When
    const reuse = (): void => {
      sessions.connect(portA, ORIGIN_A, '0xbb', 'c1');
    };

    // Then
    expect(reuse).toThrow('Duplicate chain connection: c1');
    expect(built).toHaveLength(1);
    expect(sessions.size).toBe(1);
  });

  it('As a dotli user on the shared light client, three tabs each holding five connections all connect', () => {
    // Given
    const { sessions } = setup();
    const ports = [{}, {}, {}] as MessagePort[];

    // When
    const connectAll = (): void => {
      ports.forEach((port, tab) => {
        for (let i = 0; i < 5; i++) {
          sessions.connect(port, `https://tab${String(tab)}.example`, '0xaa', `c${String(i)}`);
        }
      });
    };

    // Then
    expect(connectAll).not.toThrow();
    expect(sessions.size).toBe(15);
  });

  it("As a dotli user on the shared light client, two tabs of one site each get a tab's limit", () => {
    // Given
    const { sessions, portA, portB } = setup();

    // When
    const connectAll = (): void => {
      for (const [tab, port] of [portA, portB].entries()) {
        for (let i = 0; i < MAX_CHAIN_CONNECTIONS; i++) {
          sessions.connect(port, ORIGIN_A, '0xaa', `t${String(tab)}c${String(i)}`);
        }
      }
    };

    // Then
    expect(connectAll).not.toThrow();
    expect(sessions.size).toBe(2 * MAX_CHAIN_CONNECTIONS);
  });

  it("As a dotli user on the shared light client, a closed tab's connections no longer count against its limit", () => {
    // Given
    const { sessions, portA } = setup();
    for (let i = 0; i < MAX_CHAIN_CONNECTIONS; i++) {
      sessions.connect(portA, ORIGIN_A, '0xaa', `c${String(i)}`);
    }

    // When
    sessions.removePort(portA);
    const reconnect = (): void => {
      for (let i = 0; i < MAX_CHAIN_CONNECTIONS; i++) {
        sessions.connect(portA, ORIGIN_A, '0xaa', `again${String(i)}`);
      }
    };

    // Then
    expect(reconnect).not.toThrow();
    expect(sessions.size).toBe(MAX_CHAIN_CONNECTIONS);
  });

  it('As a dotli user on the shared light client, a tab stops getting connections at its limit', () => {
    // Given
    const { sessions, portA } = setup();
    for (let i = 0; i < MAX_CHAIN_CONNECTIONS; i++) {
      sessions.connect(portA, `https://site${String(i)}.example`, '0xaa', 'c');
    }

    // When
    const overflow = (): void => {
      sessions.connect(portA, 'https://extra.example', '0xaa', 'c');
    };

    // Then
    expect(overflow).toThrow('Connection limit reached (max 10)');
  });

  it('As a dotli user on the shared light client, a tab at its limit gets a connection again once it closes one', () => {
    // Given
    const { sessions, portA } = setup();
    for (let i = 0; i < MAX_CHAIN_CONNECTIONS; i++) {
      sessions.connect(portA, ORIGIN_A, '0xaa', `c${String(i)}`);
    }

    // When
    const overflow = (): void => {
      sessions.connect(portA, ORIGIN_A, '0xaa', 'extra');
    };

    // Then
    expect(overflow).toThrow('Connection limit reached (max 10)');
    sessions.disconnect(ORIGIN_A, 'c0');
    sessions.connect(portA, ORIGIN_A, '0xaa', 'c0');
    expect(sessions.size).toBe(MAX_CHAIN_CONNECTIONS);
  });

  it("As a dotli user on the shared light client, a halt on one site's connection leaves another site's same-id connection working", () => {
    // Given
    const { sessions, built, posted, portA, portB } = setup();
    sessions.connect(portA, ORIGIN_A, '0xaa', 'c1');
    sessions.connect(portB, ORIGIN_B, '0xbb', 'c1');

    // When
    haltTransport(must(built[0], 'first chain'));

    // Then
    expect(posted.map(p => p.port)).toEqual([portA]);
    expect(posted.map(p => p.envelope)).toEqual([
      { namespace: 'dotli:protocol', kind: 'chain-halt', connectionId: 'c1' },
    ]);
    expect(sessions.size).toBe(1);
    sessions.send(ORIGIN_B, 'c1', genesisRequest('q1'));
    expect(must(built[1], 'second chain').sent).toHaveLength(1);
  });

  it('As a dotli user on the shared light client, a halt reaching a tab that already closed is survived and releases nothing twice', () => {
    // Given
    const { sessions, built, portA } = setup((getSessions, port, envelope) => {
      if (envelope.kind === 'chain-halt') {
        getSessions().removePort(port);
        throw new Error('port closed');
      }
    });
    sessions.connect(portA, ORIGIN_A, '0xaa', 'c1');
    sessions.connect(portA, ORIGIN_A, '0xbb', 'c2');

    // When
    const halt = (): void => {
      haltTransport(must(built[0], 'first chain'));
    };

    // Then
    expect(halt).not.toThrow();
    expect(sessions.size).toBe(0);
    expect(must(built[0], 'first chain').disconnect.mock.calls.length).toBeLessThanOrEqual(1);
    expect(must(built[1], 'second chain').disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user on the shared light client, an unsupported chain is refused', () => {
    // Given
    const pool = createChainPool({
      createTransport: () => () => ({ send: () => undefined, disconnect: () => undefined }),
      destroyDelay: 0,
    });
    const sessions = createWorkerChainSessions(
      pool,
      () => false,
      () => undefined,
      () => undefined,
    );

    // When
    const connect = (): void => {
      sessions.connect({} as MessagePort, ORIGIN_A, '0xdead', 'c1');
    };

    // Then
    expect(connect).toThrow('Unsupported chain: 0xdead');
  });
});
