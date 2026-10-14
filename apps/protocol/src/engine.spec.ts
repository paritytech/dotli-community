// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { must } from '@dotli/shared/testing';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { createChainPool, type ChainPool } from '@dotli/chains';
import type { ProtocolEnvelope, ProtocolRequestEnvelope, ProtocolRequestMap } from '@dotli/protocol';
import type { ChainTransportHooks } from '@dotli/chains';
import {
  createEngine,
  MAX_CONNS,
  type EngineOptions,
  type EngineResolver,
  type EngineScope,
  type ProtocolEngine,
} from './engine.js';

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

let requestCounter = 0;

/** Collects every envelope the engine answers with, including later ones. */
async function call<M extends keyof ProtocolRequestMap>(
  scope: EngineScope,
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
  await scope.handleRequest(request, origin, envelope => out.push(envelope));
  return out;
}

function setup(
  extra: Partial<EngineOptions> = {},
  destroyDelay = Infinity,
): { engine: ProtocolEngine; scope: EngineScope; built: TransportRecord[]; opened: string[] } {
  const { createChainProvider, built } = createTransports();
  const pool = createChainPool({ createTransport: createChainProvider, destroyDelay });
  // The id of each connection the engine opens on the real pool.
  const opened: string[] = [];
  const broker: ChainPool = {
    ...pool,
    connectRemote: (genesisHash, connectionId, onMessage, onHalt) => {
      opened.push(connectionId);
      return pool.connectRemote(genesisHash, connectionId, onMessage, onHalt);
    },
  };
  const engine = createEngine({ broker, isChainSupported: () => true, ...extra });
  return { engine, scope: engine.openScope(), built, opened };
}

describe('createEngine chain connections', () => {
  it('As a dotli integrator, a remote chain connection carries requests and answers', async () => {
    // Given
    const { scope, built } = setup();
    const connected = await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });

    // When
    await call(scope, 'chainSend', {
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
    const { scope } = setup();

    // When
    const send = call(scope, 'chainSend', { connectionId: 'nope', message: '{}' });

    // Then
    await expect(send).rejects.toThrow('Unknown chain connection: nope');
  });

  it('As a dotli integrator, chainDisconnect on a connection that does not exist succeeds', async () => {
    // Given
    const { scope } = setup();

    // When
    const out = await call(scope, 'chainDisconnect', { connectionId: 'nope' });

    // Then
    expect(out[0]).toMatchObject({ kind: 'response', ok: true, result: true });
  });

  it('As a dotli user, an unsupported chain is refused', async () => {
    // Given
    const { scope } = setup({ isChainSupported: () => false });

    // When
    const connect = call(scope, 'chainConnect', { genesisHash: '0xdead', connectionId: 'c1' });

    // Then
    await expect(connect).rejects.toThrow('Unsupported chain: 0xdead');
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

describe('createEngine chain pool', () => {
  it('As the protocol frame, I hand the engine the chain pool the name resolver reads, so a product shares its chain', async () => {
    // Given: the resolver already holds a lease on the chain
    const { createChainProvider, built } = createTransports();
    const broker = createChainPool({ createTransport: createChainProvider, destroyDelay: Infinity });
    must(broker.getLocalProvider('0xaa', 'resolver'), 'resolver lease')(() => undefined);
    const engine = createEngine({ broker, isChainSupported: () => true });

    // When
    const connected = await call(engine.openScope(), 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });

    // Then
    expect(connected[0]).toMatchObject({ kind: 'response', ok: true, result: true });
    expect(built).toHaveLength(1);
  });

  it('As the protocol frame, cleaning up the engine releases the chains of the pool it was handed', async () => {
    // Given
    const { createChainProvider, built } = createTransports();
    const broker = createChainPool({ createTransport: createChainProvider, destroyDelay: Infinity });
    const engine = createEngine({ broker, isChainSupported: () => true });
    await call(engine.openScope(), 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });

    // When
    engine.cleanup();

    // Then
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('createEngine name reads', () => {
  it("As the host waiting on a name, I hear the resolver's phases as typed progress before the answer", async () => {
    // Given
    const { createChainProvider } = createTransports();
    const broker = createChainPool({ createTransport: createChainProvider, destroyDelay: Infinity });
    const resolver: EngineResolver = {
      resolveDotName: (_label, opts) => {
        opts?.onPhase?.('asset-hub-syncing');
        opts?.onPhase?.('resolving-content');
        return Promise.resolve('bafy-doom');
      },
      resolveOwner: () => Promise.resolve(null),
      resolveExecutableManifest: () => Promise.resolve({ kind: 'empty' }),
      resolveRootManifest: () => Promise.resolve({ kind: 'empty' }),
    };
    const engine = createEngine({ broker, isChainSupported: () => true, resolver });

    // When
    const out = await call(engine.openScope(), 'resolveDotName', { label: 'doom' });

    // Then
    expect(out).toMatchObject([
      { namespace: 'dotli:protocol', kind: 'progress', phase: 'asset-hub-syncing' },
      { namespace: 'dotli:protocol', kind: 'progress', phase: 'resolving-content' },
      { namespace: 'dotli:protocol', kind: 'response', ok: true, result: 'bafy-doom' },
    ]);
    expect(new Set(out.map(envelope => ('id' in envelope ? envelope.id : null))).size).toBe(1);
  });

  it.each([
    ['caps the budget a far deadline allows', 1000, 1000],
    ['leaves the budget to the deadline', undefined, 'deadline'],
  ])('As a tester, a resolve budget cap %s', async (_case, syncBudgetCapMs, expected) => {
    // Given
    const { createChainProvider } = createTransports();
    const broker = createChainPool({ createTransport: createChainProvider, destroyDelay: Infinity });
    const seen: (number | undefined)[] = [];
    const resolver: EngineResolver = {
      resolveDotName: (_label, opts) => {
        seen.push(opts?.syncTimeoutMs);
        return Promise.resolve('bafy-doom');
      },
      resolveOwner: () => Promise.resolve(null),
      resolveExecutableManifest: () => Promise.resolve({ kind: 'empty' }),
      resolveRootManifest: () => Promise.resolve({ kind: 'empty' }),
    };
    const engine = createEngine({ broker, isChainSupported: () => true, resolver, syncBudgetCapMs });
    const hour = 60 * 60 * 1000;

    // When
    await engine.openScope().handleRequest(
      {
        namespace: 'dotli:protocol',
        kind: 'request',
        id: 'r1',
        method: 'resolveDotName',
        payload: { label: 'doom' },
        deadlineMs: Date.now() + hour,
      },
      ORIGIN_A,
      () => undefined,
    );

    // Then
    expect(seen).toHaveLength(1);
    if (expected === 'deadline') {
      expect(seen[0]).toBeGreaterThan(1000);
      expect(seen[0]).toBeLessThanOrEqual(hour);
    } else {
      expect(seen[0]).toBe(expected);
    }
  });
});

describe('createEngine halts', () => {
  it('As a dotli user, a dead chain answers what my app was waiting for, then says the connection halted', async () => {
    // Given
    const { scope, built } = setup();
    const out = await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await call(scope, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') });

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
    const { scope, built } = setup();
    await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    haltTransport(must(built[0], 'transport'));

    // When
    const send = call(scope, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') });

    // Then
    await expect(send).rejects.toThrow('Unknown chain connection: c1');
    // The freed slot lets the whole quota fill again.
    for (let i = 0; i < MAX_CONNS; i += 1) {
      await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: `n${String(i)}` });
    }
  });

  it('As a dotli integrator, a client reconnecting under the same id after a halt gets a fresh chain', async () => {
    // Given
    const { scope, built } = setup();
    await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    haltTransport(must(built[0], 'transport'));

    // When
    const out = await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await call(scope, 'chainSend', { connectionId: 'c1', message: genesisRequest('q2') });

    // Then
    expect(out[0]).toMatchObject({ kind: 'response', ok: true });
    expect(built).toHaveLength(2);
    expect(must(built[1], 'rebuilt transport').sent).toHaveLength(1);
  });

  it('As a dotli user, a dead chain leaves my connections on other chains working', async () => {
    // Given
    const { scope, built } = setup();
    await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await call(scope, 'chainConnect', { genesisHash: '0xbb', connectionId: 'c2' });

    // When
    haltTransport(must(built[0], 'first chain'));
    await call(scope, 'chainSend', { connectionId: 'c2', message: genesisRequest('q1') });

    // Then
    expect(must(built[1], 'second chain').sent).toHaveLength(1);
  });
});

describe('createEngine origin binding', () => {
  it("As a dotli user, another site cannot send on my app's chain connection", async () => {
    // Given
    const { scope, built } = setup();
    await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }, ORIGIN_A);

    // When
    const send = call(scope, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') }, ORIGIN_B);

    // Then
    await expect(send).rejects.toThrow('Unknown chain connection: c1');
    expect(must(built[0], 'transport').sent).toHaveLength(0);
  });

  it("As a dotli user, another site cannot close my app's chain connection", async () => {
    // Given
    const { scope, built } = setup();
    await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }, ORIGIN_A);

    // When
    const out = await call(scope, 'chainDisconnect', { connectionId: 'c1' }, ORIGIN_B);
    await call(scope, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') }, ORIGIN_A);

    // Then
    expect(out[0]).toMatchObject({ kind: 'response', ok: true, result: true });
    expect(must(built[0], 'transport').sent).toHaveLength(1);
  });

  it('As a dotli user, a site using the same connection id as my app gets its own connection', async () => {
    // Given
    const { scope, built } = setup();
    await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }, ORIGIN_A);

    // When
    const second = await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }, ORIGIN_B);
    await call(scope, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') }, ORIGIN_A);
    await call(scope, 'chainSend', { connectionId: 'c1', message: genesisRequest('q2') }, ORIGIN_B);
    await call(scope, 'chainDisconnect', { connectionId: 'c1' }, ORIGIN_A);
    await call(scope, 'chainSend', { connectionId: 'c1', message: genesisRequest('q3') }, ORIGIN_B);

    // Then
    expect(second[0]).toMatchObject({ kind: 'response', ok: true });
    expect(must(built[0], 'transport').sent).toHaveLength(3);
  });

  it('As a dotli integrator, an app reusing its own connection id on another chain is refused', async () => {
    // Given
    const { scope, built } = setup();
    await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }, ORIGIN_A);

    // When
    const again = call(scope, 'chainConnect', { genesisHash: '0xbb', connectionId: 'c1' }, ORIGIN_A);

    // Then
    await expect(again).rejects.toThrow('Duplicate chain connection: c1');
    await call(scope, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') }, ORIGIN_A);
    expect(must(built[0], 'transport').sent).toHaveLength(1);
    expect(built).toHaveLength(1);
  });

  it("As a dotli user, another site's connection on another chain cannot take my connection id", async () => {
    // Given
    const { scope, built } = setup();
    const mine = await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }, ORIGIN_A);
    const theirs = await call(scope, 'chainConnect', { genesisHash: '0xbb', connectionId: 'c1' }, ORIGIN_B);

    // When
    await call(scope, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') }, ORIGIN_A);
    haltTransport(must(built[0], 'my chain'));
    await call(scope, 'chainSend', { connectionId: 'c1', message: genesisRequest('q2') }, ORIGIN_B);

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
    const { scope, built } = setup({}, Infinity);
    await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });

    // When
    await call(scope, 'chainDisconnect', { connectionId: 'c1' });
    vi.advanceTimersByTime(600_000);

    // Then
    expect(must(built[0], 'transport').disconnect).not.toHaveBeenCalled();
  });

  it('As a dotli user on Trusted Providers, a chain my apps stopped using closes its socket a minute later', async () => {
    // Given
    vi.useFakeTimers();
    const { scope, built } = setup({}, 60_000);
    await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await call(scope, 'chainDisconnect', { connectionId: 'c1' });

    // When
    vi.advanceTimersByTime(59_999);
    const before = must(built[0], 'transport').disconnect.mock.calls.length;
    vi.advanceTimersByTime(1);

    // Then
    expect(before).toBe(0);
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('createEngine repeated connects', () => {
  it('As a dotli integrator, a chainConnect repeated with the same id and chain answers ok and opens one connection', async () => {
    // Given
    const { scope, built, opened } = setup();
    await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });

    // When
    const again = await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await call(scope, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') });

    // Then
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ kind: 'response', ok: true, result: true });
    expect(built).toHaveLength(1);
    expect(must(built[0], 'transport').sent).toHaveLength(1);
    expect(opened).toEqual([expect.stringMatching(/ c1$/) as string]);
  });

  it('As a dotli integrator, I repeat a chainConnect at the tab limit and it answers ok', async () => {
    // Given a tab at its limit
    const { scope, built } = setup();
    for (let i = 0; i < MAX_CONNS; i++) {
      await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: `c${String(i)}` });
    }

    // When it repeats one of its connects
    const again = await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c0' });

    // Then it keeps the connection it has, instead of being refused for the limit
    expect(again[0]).toMatchObject({ kind: 'response', ok: true, result: true });
    expect(built).toHaveLength(1);
  });
});

describe('createEngine scopes', () => {
  it('As a dotli user on the shared light client, my chain answers reach my tab and not another tab of the same site', async () => {
    // Given
    const { engine, built } = setup();
    const mine = engine.openScope();
    const theirs = engine.openScope();
    const heardByMine = await call(mine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    const heardByTheirs = await call(theirs, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });

    // When
    await call(mine, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') });
    const transport = must(built[0], 'transport');
    transport.emit({ jsonrpc: '2.0', id: must(transport.sent[0], 'request').id ?? null, result: '0xaa' });

    // Then
    expect(heardByMine.map(envelope => envelope.kind)).toEqual(['response', 'chain-message']);
    expect(heardByTheirs.map(envelope => envelope.kind)).toEqual(['response']);
  });

  it('As a dotli user on the shared light client, another tab of my site cannot send on or close my connection', async () => {
    // Given
    const { engine, built } = setup();
    const mine = engine.openScope();
    const theirs = engine.openScope();
    await call(mine, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });

    // When
    const send = call(theirs, 'chainSend', { connectionId: 'c1', message: genesisRequest('q1') });
    await call(theirs, 'chainDisconnect', { connectionId: 'c1' });

    // Then
    await expect(send).rejects.toThrow('Unknown chain connection: c1');
    await call(mine, 'chainSend', { connectionId: 'c1', message: genesisRequest('q2') });
    expect(must(built[0], 'transport').sent).toHaveLength(1);
  });

  it("As a dotli user on the shared light client, two tabs of one site each get a tab's limit", async () => {
    // Given
    const { engine } = setup();
    const tabs = [engine.openScope(), engine.openScope()];

    // When
    const connected = await Promise.all(
      tabs.flatMap((tab, t) =>
        Array.from({ length: MAX_CONNS }, (_, i) =>
          call(tab, 'chainConnect', { genesisHash: '0xaa', connectionId: `t${String(t)}c${String(i)}` }),
        ),
      ),
    );

    // Then
    expect(connected.flat().map(envelope => envelope.kind === 'response' && envelope.ok)).toEqual(
      Array.from({ length: 2 * MAX_CONNS }, () => true),
    );
  });

  it('As a dotli user on the shared light client, a tab stops getting connections at its limit, whatever the site', async () => {
    // Given
    const { scope } = setup();
    for (let i = 0; i < MAX_CONNS; i++) {
      await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c' }, `https://site${String(i)}.example`);
    }

    // When
    const overflow = call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c' }, 'https://extra.example');

    // Then
    await expect(overflow).rejects.toThrow('Connection limit reached (max 10)');
  });

  it('As a dotli user on the shared light client, I disconnect one connection at my tab limit and can connect again', async () => {
    // Given a tab at its limit, whose next connect is refused
    const { scope } = setup();
    for (let i = 0; i < MAX_CONNS; i++) {
      await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: `c${String(i)}` });
    }
    const overflow = call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'extra' });
    await expect(overflow).rejects.toThrow('Connection limit reached (max 10)');

    // When it disconnects one and connects again
    await call(scope, 'chainDisconnect', { connectionId: 'c0' });
    const again = await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'extra' });

    // Then
    expect(again[0]).toMatchObject({ kind: 'response', ok: true, result: true });
  });

  it("As a dotli user on the shared light client, closing a tab releases only that tab's connections and frees its limit", async () => {
    // Given
    const { engine, built } = setup({}, 0);
    const closing = engine.openScope();
    const staying = engine.openScope();
    await call(closing, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await call(staying, 'chainConnect', { genesisHash: '0xbb', connectionId: 'c2' });

    // When
    const released = closing.close();

    // Then
    expect(released).toBe(1);
    expect(must(built[0], 'first chain').disconnect).toHaveBeenCalledTimes(1);
    expect(must(built[1], 'second chain').disconnect).not.toHaveBeenCalled();
    for (let i = 0; i < MAX_CONNS; i++) {
      await call(closing, 'chainConnect', { genesisHash: '0xaa', connectionId: `again${String(i)}` });
    }
  });

  it('As a dotli user on the shared light client, a tab closed with halts hears each connection halted before it is released', async () => {
    // Given a tab holding two connections
    const { scope, built } = setup({}, 0);
    const heard = await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await call(scope, 'chainConnect', { genesisHash: '0xbb', connectionId: 'c2' });

    // When
    const released = scope.close({ halt: true });

    // Then
    expect(released).toBe(2);
    expect(heard.at(-1)).toEqual({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId: 'c1' });
    expect(must(built[0], 'first chain').disconnect).toHaveBeenCalledTimes(1);
    expect(must(built[1], 'second chain').disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user on the shared light client, closing a tab after its chain died releases only what is left', async () => {
    // Given
    const { scope, built } = setup({}, 0);
    await call(scope, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await call(scope, 'chainConnect', { genesisHash: '0xbb', connectionId: 'c2' });
    haltTransport(must(built[0], 'first chain'));

    // When
    const released = scope.close();

    // Then
    expect(released).toBe(1);
    expect(must(built[1], 'second chain').disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user on the shared light client, a halt that closes my tab while it is told releases nothing twice', async () => {
    // Given a tab whose port turns out closed when the halt is posted to it
    const { engine, built } = setup({}, 0);
    const scope = engine.openScope();
    const closeOnHalt = (envelope: ProtocolEnvelope): void => {
      if (envelope.kind === 'chain-halt') {
        scope.close();
      }
    };
    await scope.handleRequest(
      {
        namespace: 'dotli:protocol',
        kind: 'request',
        id: 'r1',
        method: 'chainConnect',
        payload: { genesisHash: '0xaa', connectionId: 'c1' },
      },
      ORIGIN_A,
      closeOnHalt,
    );
    await scope.handleRequest(
      {
        namespace: 'dotli:protocol',
        kind: 'request',
        id: 'r2',
        method: 'chainConnect',
        payload: { genesisHash: '0xbb', connectionId: 'c2' },
      },
      ORIGIN_A,
      closeOnHalt,
    );

    // When
    haltTransport(must(built[0], 'first chain'));

    // Then
    expect(must(built[0], 'first chain').disconnect).toHaveBeenCalledTimes(1);
    expect(must(built[1], 'second chain').disconnect).toHaveBeenCalledTimes(1);
    expect(scope.close()).toBe(0);
  });
});
