// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import type { ProtocolEnvelope, ProtocolRequestEnvelope, ProtocolRequestMap } from '@dotli/protocol';
import type { ChainTransportHooks } from '@dotli/resolver';
import { log } from '@dotli/shared';
import { createEngine, MAX_CONNS, type EngineOptions, type ProtocolEngine } from '../src/engine.js';

const ORIGIN_A = 'https://a.example';
const ORIGIN_B = 'https://b.example';

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

function setup(
  extra: Partial<EngineOptions> = {},
  destroyDelay = Infinity,
): { engine: ProtocolEngine; built: TransportRecord[] } {
  const { createChainProvider, built } = createTransports();
  const engine = createEngine({ createChainProvider, isChainSupported: () => true, destroyDelay, ...extra });
  return { engine, built };
}

// The broker traces each lease it opens and closes at debug level.
let debug: Mock<(...args: unknown[]) => void>;

beforeEach(() => {
  debug = vi.fn<(...args: unknown[]) => void>();
  vi.spyOn(log, 'debug').mockImplementation(debug);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const traced = (line: string): unknown[] => ['[dot.li broker]', expect.stringContaining(line)];

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
    expect(debug).toHaveBeenCalledWith(...traced('c1 connecting'));
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

/** The transport reports itself dead, as a smoldot chain does. */
function haltTransport(transport: TransportRecord): void {
  const hooks = must(transport.hooks, 'transport hooks');
  hooks.onStatus('disconnected');
  hooks.onHalt(new Error('chain died'));
}

const genesisRequest = (id: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'chainSpec_v1_genesisHash', params: [] });

describe('createEngine halts', () => {
  it('As a dotli user, a dead chain answers what my app was waiting for, then says the connection halted', async () => {
    // Given
    const { engine, built } = setup();
    const out = await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await call(engine, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') });

    // When
    haltTransport(must(built[0], 'transport'));

    // Then
    expect(out.slice(1)).toEqual([
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
  });

  it('As a dotli integrator, a halted connection is gone and frees its slot', async () => {
    // Given
    const { engine, built } = setup();
    await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    haltTransport(must(built[0], 'transport'));

    // When
    const send = call(engine, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') });

    // Then
    await expect(send).rejects.toThrow('Unknown chain connection: c1');
    // The halted connection's slot is free: the whole quota can be filled again.
    for (let i = 0; i < MAX_CONNS; i += 1) {
      await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: `n${String(i)}` });
    }
  });

  it('As a dotli integrator, a client reconnecting under the same id after a halt gets a fresh chain', async () => {
    // Given
    const { engine, built } = setup();
    await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    haltTransport(must(built[0], 'transport'));

    // When
    const out = await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await call(engine, 'chainSend', { connectionId: 'c1', message: genesisRequest('q2') });

    // Then
    expect(out[0]).toMatchObject({ kind: 'response', ok: true });
    expect(built).toHaveLength(2);
    expect(must(built[1], 'rebuilt transport').sent).toHaveLength(1);
  });

  it('As a dotli user, a dead chain leaves my connections on other chains working', async () => {
    // Given
    const { engine, built } = setup();
    await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await call(engine, 'chainConnect', { genesisHash: '0xbb', connectionId: 'c2' });

    // When
    haltTransport(must(built[0], 'first chain'));
    await call(engine, 'chainSend', { connectionId: 'c2', message: genesisRequest('q1') });

    // Then
    expect(must(built[1], 'second chain').sent).toHaveLength(1);
  });
});

describe('createEngine origin binding', () => {
  it("As a dotli user, another site cannot send on my app's chain connection", async () => {
    // Given
    const { engine, built } = setup();
    await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }, ORIGIN_A);

    // When
    const send = call(engine, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') }, ORIGIN_B);

    // Then
    await expect(send).rejects.toThrow('Unknown chain connection: c1');
    expect(must(built[0], 'transport').sent).toHaveLength(0);
  });

  it("As a dotli user, another site cannot close my app's chain connection", async () => {
    // Given
    const { engine, built } = setup();
    await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }, ORIGIN_A);

    // When
    const out = await call(engine, 'chainDisconnect', { connectionId: 'c1' }, ORIGIN_B);
    await call(engine, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') }, ORIGIN_A);

    // Then
    expect(out[0]).toMatchObject({ kind: 'response', ok: true, result: true });
    expect(must(built[0], 'transport').sent).toHaveLength(1);
  });

  it('As a dotli user, a site using the same connection id as my app gets its own connection', async () => {
    // Given
    const { engine, built } = setup();
    await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }, ORIGIN_A);

    // When
    const second = await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }, ORIGIN_B);
    await call(engine, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') }, ORIGIN_A);
    await call(engine, 'chainSend', { connectionId: 'c1', message: genesisRequest('q2') }, ORIGIN_B);
    await call(engine, 'chainDisconnect', { connectionId: 'c1' }, ORIGIN_A);
    await call(engine, 'chainSend', { connectionId: 'c1', message: genesisRequest('q3') }, ORIGIN_B);

    // Then
    expect(second[0]).toMatchObject({ kind: 'response', ok: true });
    expect(must(built[0], 'transport').sent).toHaveLength(3);
  });

  it('As a dotli integrator, an app reusing its own connection id on another chain is refused', async () => {
    // Given
    const { engine, built } = setup();
    await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }, ORIGIN_A);

    // When
    const again = call(engine, 'chainConnect', { genesisHash: '0xbb', connectionId: 'c1' }, ORIGIN_A);

    // Then
    await expect(again).rejects.toThrow('Duplicate chain connection: c1');
    await call(engine, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') }, ORIGIN_A);
    expect(must(built[0], 'transport').sent).toHaveLength(1);
    expect(built).toHaveLength(1);
  });

  it("As a dotli user, another site's connection on another chain cannot take my connection id", async () => {
    // Given
    const { engine, built } = setup();
    const mine = await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }, ORIGIN_A);
    const theirs = await call(engine, 'chainConnect', { genesisHash: '0xbb', connectionId: 'c1' }, ORIGIN_B);

    // When
    await call(engine, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') }, ORIGIN_A);
    haltTransport(must(built[0], 'my chain'));
    await call(engine, 'chainSend', { connectionId: 'c1', message: genesisRequest('q2') }, ORIGIN_B);

    // Then
    expect(theirs[0]).toMatchObject({ kind: 'response', ok: true });
    expect(must(built[0], 'my chain').sent).toHaveLength(1);
    expect(must(built[1], 'their chain').sent).toHaveLength(1);
    expect(mine.at(-1)).toEqual({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId: 'c1' });
    expect(theirs.some(envelope => envelope.kind === 'chain-halt')).toBe(false);
  });
});

describe('createEngine destroy delay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a dotli user on a light client, a chain my apps stopped using stays synced', async () => {
    // Given
    vi.useFakeTimers();
    const { engine, built } = setup({}, Infinity);
    await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });

    // When
    await call(engine, 'chainDisconnect', { connectionId: 'c1' });
    vi.advanceTimersByTime(600_000);

    // Then
    expect(must(built[0], 'transport').disconnect).not.toHaveBeenCalled();
  });

  it('As a dotli user on Trusted Providers, a chain my apps stopped using closes its socket a minute later', async () => {
    // Given
    vi.useFakeTimers();
    const { engine, built } = setup({}, 60_000);
    await call(engine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await call(engine, 'chainDisconnect', { connectionId: 'c1' });

    // When
    vi.advanceTimersByTime(59_999);
    const before = must(built[0], 'transport').disconnect.mock.calls.length;
    vi.advanceTimersByTime(1);

    // Then
    expect(before).toBe(0);
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
  });
});
