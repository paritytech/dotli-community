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
import { createChainPool, type ChainPool, type ChainTransportHooks } from '@dotli/chains';
import { TIMEOUTS } from '@dotli/config';
import type { ConsumerTransport } from '@dotli/protocol';
import {
  createEngine,
  MAX_CONNS,
  serveEngineScope,
  type EngineOptions,
  type EngineResolver,
  type EngineScope,
  type ProtocolEngine,
} from './engine.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { closeHostLinks, linkHost, record, type Recording } from './testing/host-link.js';

afterEach(() => {
  vi.useRealTimers();
  closeHostLinks();
});

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

/** One host page served by one engine scope over the wire. */
interface Tab {
  host: ConsumerTransport;
  scope: EngineScope;
  /** Settles once the chain is connected or the connect ended. */
  connect: (genesisHash: string, connectionId: string) => Promise<Recording<'chainConnect'>>;
  send: (connectionId: string, message: string) => Promise<void>;
}

function openTab(engine: ProtocolEngine): Tab {
  const { serving, host } = linkHost();
  const scope = serveEngineScope(serving, engine);
  return {
    host,
    scope,
    connect: async (genesisHash, connectionId) => {
      const chain = record(host, 'chainConnect', { genesisHash, connectionId });
      await Promise.race([chain.until(1), chain.ended]);
      return chain;
    },
    send: (connectionId, message) => host.request('chainSend', { connectionId, message }),
  };
}

function setup(
  extra: Partial<EngineOptions> = {},
  destroyDelay = Infinity,
): { engine: ProtocolEngine; tab: Tab; built: TransportRecord[]; opened: string[] } {
  const { createChainProvider, built } = createTransports();
  const pool = createChainPool({ createTransport: createChainProvider, destroyDelay });
  // The id of each connection the engine opens on the real pool.
  const opened: string[] = [];
  const counting: ChainPool = {
    ...pool,
    connectRemote: (genesisHash, connectionId, onMessage, onHalt) => {
      opened.push(connectionId);
      return pool.connectRemote(genesisHash, connectionId, onMessage, onHalt);
    },
  };
  const engine = createEngine({ pool: counting, isChainSupported: () => true, ...extra });
  return { engine, tab: openTab(engine), built, opened };
}

const CONNECTED = { tag: 'connected' };

/** The transport reports itself dead, as a smoldot chain does. */
function haltTransport(transport: TransportRecord): void {
  const hooks = must(transport.hooks, 'transport hooks');
  hooks.onStatus('disconnected');
  hooks.onHalt(new Error('chain died'));
}

const genesisRequest = (id: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'chainSpec_v1_genesisHash', params: [] });

function resolverOf(resolveDotName: EngineResolver['resolveDotName']): EngineResolver {
  return {
    resolveDotName,
    resolveOwner: () => Promise.resolve(null),
    resolveExecutableManifest: () => Promise.resolve({ kind: 'empty' }),
    resolveRootManifest: () => Promise.resolve({ kind: 'empty' }),
  };
}

describe('createEngine chain connections', () => {
  it('As a product, a remote chain connection carries requests and answers', async () => {
    // Given
    const { tab, built } = setup();
    const chain = await tab.connect('0xaa', 'c1');

    // When
    await tab.send('c1', genesisRequest('q1'));
    const transport = must(built[0], 'transport');
    transport.emit({ jsonrpc: '2.0', id: must(transport.sent[0], 'request').id ?? null, result: '0xaa' });
    await chain.until(2);

    // Then
    expect(chain.events[0]).toEqual(CONNECTED);
    const answer = must(chain.events[1], 'answer');
    expect(answer.tag === 'message' ? JSON.parse(answer.value) : answer).toEqual({
      jsonrpc: '2.0',
      id: 'q1',
      result: '0xaa',
    });
  });

  it('As a product, a send on a connection that does not exist fails', async () => {
    // Given
    const { tab } = setup();

    // When
    const send = tab.send('nope', '{}');

    // Then
    await expect(send).rejects.toThrow('Unknown chain connection: nope');
  });

  it('As a dotli user, an unsupported chain is refused', async () => {
    // Given
    const { tab } = setup({ isChainSupported: () => false });

    // When
    const chain = await tab.connect('0xdead', 'c1');

    // Then
    expect(await chain.ended).toMatchObject({ message: 'Unsupported chain: 0xdead' });
    expect(chain.events).toEqual([]);
  });

  it('As the host, my connect is refused at the connection limit and the subscription ends with that error', async () => {
    // Given a tab at its limit
    const { tab } = setup();
    for (let i = 0; i < MAX_CONNS; i++) {
      await tab.connect('0xaa', `c${String(i)}`);
    }

    // When
    const overflow = await tab.connect('0xaa', 'extra');

    // Then
    expect(await overflow.ended).toMatchObject({ message: 'Connection limit reached (max 10)' });
    expect(overflow.events).toEqual([]);
  });

  it('As the host, my unsubscribe disconnects the chain', async () => {
    // Given
    const { tab, built } = setup({}, 0);
    const chain = await tab.connect('0xaa', 'c1');

    // When
    chain.unsubscribe();

    // Then the connection is gone by the time a later call is answered
    await expect(tab.send('c1', genesisRequest('q1'))).rejects.toThrow('Unknown chain connection: c1');
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a product, a second connect under a live connection id is refused and the first keeps working', async () => {
    // Given
    const { tab, built } = setup();
    await tab.connect('0xaa', 'c1');

    // When
    const again = await tab.connect('0xaa', 'c1');
    const elsewhere = await tab.connect('0xbb', 'c1');

    // Then
    expect(await again.ended).toMatchObject({ message: 'Duplicate chain connection: c1' });
    expect(await elsewhere.ended).toMatchObject({ message: 'Duplicate chain connection: c1' });
    await tab.send('c1', genesisRequest('q1'));
    expect(built).toHaveLength(1);
    expect(must(built[0], 'transport').sent).toHaveLength(1);
  });
});

describe('createEngine chain pool', () => {
  it('As the protocol frame, I hand the engine the chain pool the name resolver reads, so a product shares its chain', async () => {
    // Given the resolver already holds a lease on the chain
    const { createChainProvider, built } = createTransports();
    const pool = createChainPool({ createTransport: createChainProvider, destroyDelay: Infinity });
    must(pool.getLocalProvider('0xaa', 'resolver'), 'resolver lease')(() => undefined);
    const engine = createEngine({ pool, isChainSupported: () => true });

    // When
    const chain = await openTab(engine).connect('0xaa', 'c1');

    // Then
    expect(chain.events).toEqual([CONNECTED]);
    expect(built).toHaveLength(1);
  });

  it('As the protocol frame, cleaning up the engine releases the chains of the pool it was handed', async () => {
    // Given
    const { createChainProvider, built } = createTransports();
    const pool = createChainPool({ createTransport: createChainProvider, destroyDelay: Infinity });
    const engine = createEngine({ pool, isChainSupported: () => true });
    await openTab(engine).connect('0xaa', 'c1');

    // When
    engine.cleanup();

    // Then
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('createEngine name reads', () => {
  it("As the host waiting on a name, I hear the resolver's phases, then the name, then the end", async () => {
    // Given
    const { tab } = setup({
      resolver: resolverOf((_label, opts) => {
        opts?.onPhase?.('asset-hub-syncing');
        opts?.onPhase?.('resolving-content');
        return Promise.resolve('bafy-doom');
      }),
    });

    // When
    const read = record(tab.host, 'resolveDotName', { label: 'doom' });

    // Then
    expect(await read.ended).toBeNull();
    expect(read.events).toEqual([
      { tag: 'phase', value: 'asset-hub-syncing' },
      { tag: 'phase', value: 'resolving-content' },
      { tag: 'resolved', value: 'bafy-doom' },
    ]);
  });

  it('As the host, a name read that fails ends with its error', async () => {
    // Given
    const { tab } = setup({ resolver: resolverOf(() => Promise.reject(new TypeError('bad label'))) });

    // When
    const read = record(tab.host, 'resolveDotName', { label: 'doom' });

    // Then
    expect(await read.ended).toMatchObject({ name: 'TypeError', message: 'bad label' });
  });

  it('As the host in gateway mode, every name read is refused at once', async () => {
    // Given an engine with no resolver
    const { tab } = setup();

    // When
    const read = record(tab.host, 'resolveDotName', { label: 'doom' });
    const owner = tab.host.request('resolveOwner', { label: 'doom' });

    // Then
    expect(await read.ended).toMatchObject({ message: PROTOCOL_APP_ERRORS.RESOLVE_DOT_NAME_UNSUPPORTED });
    await expect(owner).rejects.toThrow(PROTOCOL_APP_ERRORS.RESOLVE_OWNER_UNSUPPORTED);
  });

  const HOUR = 60 * 60 * 1000;

  it.each([
    ['caps the budget a far deadline allows', 1000, 1000],
    [
      'leaves the budget to what is left of the deadline, less the delivery grace',
      undefined,
      HOUR - TIMEOUTS.RESPONSE_DELIVERY_GRACE,
    ],
  ])('As a tester, a resolve budget cap %s', async (_case, syncBudgetCapMs, expected) => {
    // Given a frame clock at 10 s and a host deadline an hour later
    const seen: (number | undefined)[] = [];
    const { tab } = setup({
      resolver: resolverOf((_label, opts) => {
        seen.push(opts?.syncTimeoutMs);
        return Promise.resolve('bafy-doom');
      }),
      syncBudgetCapMs,
      timers: { now: () => 10_000 },
    });

    // When
    await record(tab.host, 'resolveDotName', { label: 'doom' }, { deadlineMs: 10_000 + HOUR }).ended;

    // Then
    expect(seen).toEqual([expected]);
  });

  it('As the host, a read without a deadline leaves the budget to the resolver', async () => {
    // Given
    const seen: unknown[] = [];
    const { tab } = setup({
      resolver: {
        ...resolverOf(() => Promise.resolve(null)),
        resolveOwner: (_label, opts) => {
          seen.push(opts);
          return Promise.resolve('0xowner');
        },
      },
    });

    // When
    const owner = await tab.host.request('resolveOwner', { label: 'doom' });

    // Then
    expect(owner).toBe('0xowner');
    expect(seen).toEqual([{}]);
  });
});

describe('createEngine halts', () => {
  it('As the host, a halted chain ends my subscription cleanly, after what my app was waiting for', async () => {
    // Given
    const { tab, built } = setup();
    const chain = await tab.connect('0xaa', 'c1');
    await tab.send('c1', genesisRequest('q1'));

    // When
    haltTransport(must(built[0], 'transport'));

    // Then
    expect(await chain.ended).toBeNull();
    expect(chain.events).toEqual([
      CONNECTED,
      {
        tag: 'message',
        value: JSON.stringify({
          jsonrpc: '2.0',
          id: 'q1',
          error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
        }),
      },
    ]);
  });

  it('As a product, a halted connection is gone and frees its slot', async () => {
    // Given
    const { tab, built } = setup();
    const chain = await tab.connect('0xaa', 'c1');
    haltTransport(must(built[0], 'transport'));
    await chain.ended;

    // When
    const send = tab.send('c1', genesisRequest('q1'));

    // Then
    await expect(send).rejects.toThrow('Unknown chain connection: c1');
    // The freed slot lets the whole quota fill again.
    for (let i = 0; i < MAX_CONNS; i += 1) {
      expect((await tab.connect('0xaa', `n${String(i)}`)).events).toEqual([CONNECTED]);
    }
  });

  it('As a product, reconnecting under the same id after a halt gets a fresh chain', async () => {
    // Given
    const { tab, built } = setup();
    const first = await tab.connect('0xaa', 'c1');
    haltTransport(must(built[0], 'transport'));
    await first.ended;

    // When
    const again = await tab.connect('0xaa', 'c1');
    await tab.send('c1', genesisRequest('q2'));

    // Then
    expect(again.events).toEqual([CONNECTED]);
    expect(built).toHaveLength(2);
    expect(must(built[1], 'rebuilt transport').sent).toHaveLength(1);
  });

  it('As a dotli user, a dead chain leaves my connections on other chains working', async () => {
    // Given
    const { tab, built } = setup();
    await tab.connect('0xaa', 'c1');
    await tab.connect('0xbb', 'c2');

    // When
    haltTransport(must(built[0], 'first chain'));
    await tab.send('c2', genesisRequest('q1'));

    // Then
    expect(must(built[1], 'second chain').sent).toHaveLength(1);
  });
});

describe('createEngine destroy delay', () => {
  it('As a dotli user on a light client, a chain my apps stopped using stays synced', async () => {
    // Given
    const { tab, built } = setup({}, Infinity);
    const chain = await tab.connect('0xaa', 'c1');
    vi.useFakeTimers();

    // When
    chain.unsubscribe();
    await expect(tab.send('c1', '{}')).rejects.toThrow('Unknown chain connection: c1');
    vi.advanceTimersByTime(600_000);

    // Then
    expect(must(built[0], 'transport').disconnect).not.toHaveBeenCalled();
  });

  it('As a dotli user on Trusted Providers, a chain my apps stopped using closes its socket a minute later', async () => {
    // Given
    const { tab, built } = setup({}, 60_000);
    const chain = await tab.connect('0xaa', 'c1');
    vi.useFakeTimers();
    chain.unsubscribe();
    await expect(tab.send('c1', '{}')).rejects.toThrow('Unknown chain connection: c1');

    // When
    vi.advanceTimersByTime(59_999);
    const before = must(built[0], 'transport').disconnect.mock.calls.length;
    vi.advanceTimersByTime(1);

    // Then
    expect(before).toBe(0);
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('createEngine scopes', () => {
  it('As a dotli user on the shared light client, my chain answers reach my tab and not another tab', async () => {
    // Given
    const { engine, built } = setup();
    const mine = openTab(engine);
    const theirs = openTab(engine);
    const heardByMine = await mine.connect('0xaa', 'c1');
    const heardByTheirs = await theirs.connect('0xaa', 'c1');

    // When
    await mine.send('c1', genesisRequest('q1'));
    const transport = must(built[0], 'transport');
    transport.emit({ jsonrpc: '2.0', id: must(transport.sent[0], 'request').id ?? null, result: '0xaa' });
    await heardByMine.until(2);
    await theirs.send('c1', genesisRequest('q2'));

    // Then
    expect(heardByMine.events.map(event => event.tag)).toEqual(['connected', 'message']);
    expect(heardByTheirs.events.map(event => event.tag)).toEqual(['connected']);
  });

  it('As a dotli user on the shared light client, another tab cannot send on my connection', async () => {
    // Given
    const { engine, built } = setup();
    const mine = openTab(engine);
    const theirs = openTab(engine);
    await mine.connect('0xaa', 'c1');

    // When
    const send = theirs.send('c1', genesisRequest('q1'));

    // Then
    await expect(send).rejects.toThrow('Unknown chain connection: c1');
    await mine.send('c1', genesisRequest('q2'));
    expect(must(built[0], 'transport').sent).toHaveLength(1);
  });

  it("As a dotli user on the shared light client, two tabs each get a tab's limit", async () => {
    // Given
    const { engine } = setup();
    const tabs = [openTab(engine), openTab(engine)];

    // When
    const connected = await Promise.all(
      tabs.flatMap((tab, t) =>
        Array.from({ length: MAX_CONNS }, (_, i) => tab.connect('0xaa', `t${String(t)}c${String(i)}`)),
      ),
    );

    // Then
    expect(connected.map(chain => chain.events)).toEqual(Array.from({ length: 2 * MAX_CONNS }, () => [CONNECTED]));
  });

  it('As a dotli user on the shared light client, I disconnect one connection at my tab limit and can connect again', async () => {
    // Given a tab at its limit, whose next connect is refused
    const { tab } = setup();
    const chains: Recording<'chainConnect'>[] = [];
    for (let i = 0; i < MAX_CONNS; i++) {
      chains.push(await tab.connect('0xaa', `c${String(i)}`));
    }
    const overflow = await tab.connect('0xaa', 'extra');
    expect(await overflow.ended).toMatchObject({ message: 'Connection limit reached (max 10)' });

    // When it disconnects one and connects again
    must(chains[0], 'first chain').unsubscribe();
    const again = await tab.connect('0xaa', 'extra');

    // Then
    expect(again.events).toEqual([CONNECTED]);
  });

  it('As a dotli user on the shared light client, closing a tab ends its connections, releases only them and frees its limit', async () => {
    // Given
    const { engine, built } = setup({}, 0);
    const closing = openTab(engine);
    const staying = openTab(engine);
    const first = await closing.connect('0xaa', 'c1');
    const second = await staying.connect('0xbb', 'c2');

    // When
    const released = closing.scope.close();

    // Then
    expect(released).toBe(1);
    expect(await first.ended).toBeNull();
    expect(must(built[0], 'first chain').disconnect).toHaveBeenCalledTimes(1);
    expect(must(built[1], 'second chain').disconnect).not.toHaveBeenCalled();
    await staying.send('c2', genesisRequest('q1'));
    expect(second.events).toEqual([CONNECTED]);
    for (let i = 0; i < MAX_CONNS; i++) {
      expect((await closing.connect('0xaa', `again${String(i)}`)).events).toEqual([CONNECTED]);
    }
  });

  it('As a dotli user on the shared light client, closing a tab after its chain died releases only what is left', async () => {
    // Given
    const { tab, built } = setup({}, 0);
    await tab.connect('0xaa', 'c1');
    await tab.connect('0xbb', 'c2');
    haltTransport(must(built[0], 'first chain'));

    // When
    const released = tab.scope.close();

    // Then
    expect(released).toBe(1);
    expect(must(built[1], 'second chain').disconnect).toHaveBeenCalledTimes(1);
    expect(tab.scope.close()).toBe(0);
  });
});
