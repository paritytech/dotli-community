// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { recordReports } from '@dotli/metrics/testing';
import { catchError, must } from '@dotli/shared/testing';
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { createChainPool, type ChainPool, type ChainTransport, type ChainTransportHooks } from '@dotli/chains';
import { TIMEOUTS } from '@dotli/config';
import { getBudget, protocolSchema, type RemoteFailure } from '@dotli/protocol';
import {
  domain,
  err,
  hostFailure,
  ok,
  type Failure,
  type MethodTypes,
  type ResultPayload,
  unsupported,
} from '@dotli/transport';
import { createEngine, MAX_CONNECTIONS, type EngineParams, type ProtocolEngine } from './createEngine.js';
import type { EngineResolver } from './createNameReads.js';
import { serveEngineScope } from './serveEngineMethods.js';
import { closeHostLinks, linkHost } from './testing/linkHost.js';
import { record, type Recording } from './testing/record.js';

const { chain, resolve } = protocolSchema.sections;

type ChainRecording = Recording<MethodTypes<typeof chain.connect>['receive'], RemoteFailure>;

type TransportRecord = {
  genesisHash: string;
  hooks: ChainTransportHooks | undefined;
  sent: JsonRpcRequest[];
  emit: (message: JsonRpcMessage) => void;
  disconnect: Mock<() => void>;
};

type Params = Partial<EngineParams> & {
  /** How long the pool keeps a chain nobody uses. Never, when unset. */
  destroyDelay?: number;
  /** Wraps the real pool before the engine gets it. */
  wrapPool?: (pool: ChainPool) => ChainPool;
};

afterEach(() => {
  closeHostLinks();
});

function createTransports() {
  const built: TransportRecord[] = [];
  return {
    /** Builds a recorded transport for each chain the pool opens. Never throws. */
    createChainTransport,
    /** Each transport built, in order. */
    built,
  };

  function createChainTransport(genesisHash: string, hooks?: ChainTransportHooks): ChainTransport {
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
    return { provider: connect, followLimit: Infinity };

    function connect(onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
      listener = onMessage;
      return {
        send(message) {
          record.sent.push(message);
        },
        disconnect: record.disconnect,
      };
    }
  }
}

/** Opens a host page on a new scope of `engine`. */
function openTab(engine: ProtocolEngine) {
  const { serving, host } = linkHost();
  const { scope, stop } = serveEngineScope(serving, engine);
  return {
    /** The host page's end. */
    host,
    /** The page's scope on the engine. */
    scope,
    /** Stops serving the page's scope. */
    stop,
    /** Settles once the chain is connected or the connect ended. Never rejects. */
    async connect(genesisHash: string, connectionId: string): Promise<ChainRecording> {
      const connected = record({ transport: host, method: chain.connect, start: { genesisHash, connectionId } });
      await Promise.race([connected.waitFor(1), connected.ended]);
      return connected;
    },
    /** Sends `message` on the connection and settles with the answer. */
    send: (connectionId: string, message: string): Promise<MethodTypes<typeof chain.send>['response']> =>
      host.request(chain.send, { connectionId, message }),
  };
}

/** Starts an engine on a real pool that records each transport it builds, with one tab open. */
function startEngine({ destroyDelay = Infinity, wrapPool = pool => pool, ...engineParams }: Params = {}) {
  const { createChainTransport, built } = createTransports();
  const pool = wrapPool(createChainPool({ createTransport: createChainTransport, destroyDelay }));
  const engine = createEngine({ pool, isChainSupported: () => true, ...engineParams });
  return { engine, tab: openTab(engine), built };
}

/** Watches a pool's remote connections: their disconnects and the pool's release. */
function spyOnPool() {
  const disconnects: Mock<() => void>[] = [];
  const disconnectAll = vi.fn<() => void>();
  let nextFailure: Error | null = null;
  return {
    /** Wraps `pool`, for `startEngine`. */
    wrap,
    /** Each connection's disconnect, in the order they connected. */
    disconnects,
    /** The pool's release. */
    disconnectAll,
    /** Makes the next connection's disconnect throw `error` once it has disconnected. */
    failNextDisconnect(error: Error): void {
      nextFailure = error;
    },
  };

  function wrap(pool: ChainPool): ChainPool {
    disconnectAll.mockImplementation(() => {
      pool.disconnectAll();
    });
    return {
      ...pool,
      disconnectAll,
      connectRemote(params) {
        const connection = pool.connectRemote(params);
        if (connection === null) {
          return null;
        }
        const failure = nextFailure;
        nextFailure = null;
        const disconnect = vi.fn(() => {
          connection.disconnect();
          if (failure !== null) {
            throw failure;
          }
        });
        disconnects.push(disconnect);
        return { ...connection, disconnect };
      },
    };
  }
}

const CONNECTED = { tag: 'connected' };

/** How the frame answers a call whose handler threw `message`. */
function toThrownAnswer(message: string): ResultPayload<never, Failure> {
  return err(hostFailure(`Error: ${message}`));
}

/** The transport reports itself dead, as a smoldot chain does. */
function haltTransport(transport: TransportRecord): void {
  const hooks = must(transport.hooks, 'transport hooks');
  hooks.onStatus('disconnected');
  hooks.onHalt(new Error('chain died'));
}

function toGenesisRequest(id: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'chainSpec_v1_genesisHash', params: [] });
}

function toResolver(resolveDotName: EngineResolver['resolveDotName']): EngineResolver {
  return {
    resolveDotName,
    resolveOwner: () => Promise.resolve(null),
    resolveExecutableManifest: () => Promise.resolve({ kind: 'empty' }),
    resolveRootManifest: () => Promise.resolve({ kind: 'empty' }),
  };
}

describe('createEngine chain connections', () => {
  it('As a product, I open a remote chain connection and it carries my requests and answers', async () => {
    // Given
    const { tab, built } = startEngine();
    const chain = await tab.connect('0xaa', 'c1');

    // When
    await tab.send('c1', toGenesisRequest('q1'));
    const transport = must(built[0], 'transport');
    transport.emit({ jsonrpc: '2.0', id: must(transport.sent[0], 'request').id ?? null, result: '0xaa' });
    await chain.waitFor(2);

    // Then
    expect(chain.events).toEqual([
      CONNECTED,
      { tag: 'message', value: JSON.stringify({ jsonrpc: '2.0', id: 'q1', result: '0xaa' }) },
    ]);
  });

  it("As the frame, I stop serving a page's scope and its open connection ends and its next call is refused", async () => {
    // Given a page with an open connection
    const { tab } = startEngine();
    const chain = await tab.connect('0xaa', 'c1');

    // When the frame stops serving the page's scope, and again
    tab.stop();
    const thrown = catchError(tab.stop);
    const send = await tab.send('c1', '{}');

    // Then the connection ended, the next call is refused as unserved, and the second stop did not throw
    expect(await chain.ended).toEqual(ok());
    expect(send).toEqual(err(unsupported()));
    expect(thrown).toBeUndefined();
  });

  it('As a product, I send under an empty connection id and am refused for bad input', async () => {
    // Given
    const { tab } = startEngine();

    // When
    const send = tab.send('', '{}');

    // Then
    await expect(send).resolves.toEqual(toThrownAnswer('Invalid connectionId: expected non-empty string'));
  });

  it('As a dotli user, I connect to an unsupported chain and am refused', async () => {
    // Given
    const { tab } = startEngine({ isChainSupported: () => false });

    // When
    const chain = await tab.connect('0xdead', 'c1');

    // Then
    expect(await chain.ended).toEqual(toThrownAnswer('Unsupported chain: 0xdead'));
    expect(chain.events).toEqual([]);
  });

  it('As the host, I unsubscribe and the chain disconnects', async () => {
    // Given
    const { tab, built } = startEngine({ destroyDelay: 0 });
    const chain = await tab.connect('0xaa', 'c1');

    // When the tab unsubscribes, then sends on the connection
    chain.unsubscribe();
    const answer = tab.send('c1', toGenesisRequest('q1'));

    // Then the connection is gone by the time the later call is answered
    await expect(answer).resolves.toEqual(toThrownAnswer('Unknown chain connection: c1'));
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a product, I connect again under a live connection id and am refused while the first keeps working', async () => {
    // Given
    const { tab, built } = startEngine();
    await tab.connect('0xaa', 'c1');

    // When the same id connects again, on the same chain and another, and the first then sends
    const again = await tab.connect('0xaa', 'c1');
    const elsewhere = await tab.connect('0xbb', 'c1');
    await tab.send('c1', toGenesisRequest('q1'));

    // Then
    expect(await again.ended).toEqual(toThrownAnswer('Duplicate chain connection: c1'));
    expect(await elsewhere.ended).toEqual(toThrownAnswer('Duplicate chain connection: c1'));
    expect(built).toHaveLength(1);
    expect(must(built[0], 'transport').sent).toHaveLength(1);
  });
});

describe('createEngine chain pool', () => {
  it('As the protocol frame, I dispose the engine and the chains of the pool it was handed are released', async () => {
    // Given
    const { createChainTransport, built } = createTransports();
    const pool = createChainPool({ createTransport: createChainTransport, destroyDelay: Infinity });
    const engine = createEngine({ pool, isChainSupported: () => true });
    await openTab(engine).connect('0xaa', 'c1');

    // When
    engine.dispose();

    // Then
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
  });

  it('As the frame, I dispose the engine while a disconnect throws, and the failure is reported, not thrown', async () => {
    // Given two connections, the first of whose disconnect throws
    const reports = recordReports({ onFinished: onTestFinished });
    const pool = spyOnPool();
    const { engine, tab } = startEngine({ wrapPool: pool.wrap });
    pool.failNextDisconnect(new Error('disconnect failed'));
    await tab.connect('0xaa', 'c1');
    await tab.connect('0xbb', 'c2');

    // When
    const thrown = catchError(engine.dispose);

    // Then
    expect(thrown).toBeUndefined();
    expect(reports.exceptions).toMatchObject([{ step: 'disconnect' }]);
    expect(must(pool.disconnects[1], 'second disconnect')).toHaveBeenCalledTimes(1);
    expect(pool.disconnectAll).toHaveBeenCalledTimes(1);
  });

  it('As a product, I connect on a scope of a disposed engine and am refused', async () => {
    // Given
    const { engine, tab } = startEngine();
    engine.dispose();

    // When
    const chain = await tab.connect('0xaa', 'c1');

    // Then
    expect(await chain.ended).toEqual(toThrownAnswer('The engine was disposed'));
  });
});

describe('createEngine name reads', () => {
  it("As the host waiting on a name, I read it and hear the resolver's phases, then the name, then the end", async () => {
    // Given
    const { tab } = startEngine({
      resolver: toResolver((_label, options) => {
        options?.onPhase?.('asset-hub-syncing');
        options?.onPhase?.('resolving-content');
        return Promise.resolve('bafy-doom');
      }),
    });

    // When
    const read = record({ transport: tab.host, method: resolve.dotName, start: { label: 'doom' } });

    // Then
    expect(await read.ended).toEqual(ok());
    expect(read.events).toEqual([
      { tag: 'phase', value: 'asset-hub-syncing' },
      { tag: 'phase', value: 'resolving-content' },
      { tag: 'resolved', value: 'bafy-doom' },
    ]);
  });

  it('As the host in gateway mode, I read names and every read is refused at once', async () => {
    // Given an engine with no resolver
    const { tab } = startEngine();

    // When
    const read = record({ transport: tab.host, method: resolve.dotName, start: { label: 'doom' } });
    const owner = tab.host.request(resolve.owner, { label: 'doom' });

    // Then
    expect(await read.ended).toEqual(toThrownAnswer('resolveDotName is not served by this protocol mode'));
    await expect(owner).resolves.toEqual(toThrownAnswer('resolveOwner is not served by this protocol mode'));
  });

  it.each([
    ["is set below its method's budget", 1000, 1000],
    [
      "is unset, so its method's budget less the delivery grace holds",
      undefined,
      (getBudget(protocolSchema.sections.resolve.dotName) ?? 0) - TIMEOUTS.RESPONSE_DELIVERY_GRACE,
    ],
  ])(
    'As a tester, I resolve a name while the budget cap %s and the resolver gets that budget',
    async (_case, syncBudgetCapMs, expected) => {
      // Given
      const seen: (number | undefined)[] = [];
      const { tab } = startEngine({
        resolver: toResolver((_label, options) => {
          seen.push(options?.syncTimeoutMs);
          return Promise.resolve('bafy-doom');
        }),
        syncBudgetCapMs,
      });

      // When
      await record({ transport: tab.host, method: resolve.dotName, start: { label: 'doom' } }).ended;

      // Then
      expect(seen).toEqual([expected]);
    },
  );

  it("As the frame, I serve a resolve request without a deadline from the caller and size its sync budget from its method's budget", async () => {
    // Given a resolver that records the sync budget of each read
    const seen: unknown[] = [];
    const { tab } = startEngine({
      resolver: {
        resolveDotName: () => Promise.resolve(null),
        resolveOwner(_label, options) {
          seen.push(['owner', options]);
          return Promise.resolve('0xowner');
        },
        resolveExecutableManifest(_label, _kind, options) {
          seen.push(['executableManifest', options]);
          return Promise.resolve({ kind: 'empty' });
        },
        resolveRootManifest(_label, options) {
          seen.push(['rootManifest', options]);
          return Promise.resolve({ kind: 'empty' });
        },
      },
    });

    // When the host reads, sending no deadline
    const owner = await tab.host.request(resolve.owner, { label: 'doom' });
    await tab.host.request(resolve.executableManifest, { label: 'doom', kind: 'app' });
    await tab.host.request(resolve.rootManifest, { label: 'doom' });

    // Then each read has its method's budget, less the grace for the answer to cross back
    const grace = TIMEOUTS.RESPONSE_DELIVERY_GRACE;
    expect(owner).toEqual(ok('0xowner'));
    expect(seen).toEqual([
      ['owner', { syncTimeoutMs: must(getBudget(resolve.owner), 'owner budget') - grace }],
      ['executableManifest', { syncTimeoutMs: must(getBudget(resolve.executableManifest), 'budget') - grace }],
      ['rootManifest', { syncTimeoutMs: must(getBudget(resolve.rootManifest), 'root budget') - grace }],
    ]);
  });

  it('As the host, I read names whose resolver times out or stops and each error crosses typed, so my error screen tells them apart', async () => {
    // Given a resolver whose reads fail as the error screen knows them
    const toNamedError = (name: string, message: string): Error => Object.assign(new Error(message), { name });
    const { tab } = startEngine({
      resolver: {
        ...toResolver(() => Promise.reject(toNamedError('ApiStoppedError', 'The light client stopped'))),
        resolveOwner: () => Promise.reject(toNamedError('NetworkSyncTimeoutError', 'Asset Hub did not sync in time')),
      },
    });

    // When
    const owner = await tab.host.request(resolve.owner, { label: 'doom' });
    const name = await record({ transport: tab.host, method: resolve.dotName, start: { label: 'doom' } }).ended;

    // Then
    expect(owner).toEqual(err(domain({ tag: 'syncTimeout', value: 'Asset Hub did not sync in time' })));
    expect(name).toEqual(err(domain({ tag: 'apiStopped', value: 'The light client stopped' })));
  });
});

describe('createEngine halts', () => {
  it('As the host, I watch my chain halt and my subscription ends cleanly, after what my app was waiting for', async () => {
    // Given
    const { tab, built } = startEngine();
    const chain = await tab.connect('0xaa', 'c1');
    await tab.send('c1', toGenesisRequest('q1'));

    // When
    haltTransport(must(built[0], 'transport'));

    // Then
    expect(await chain.ended).toEqual(ok());
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

  it('As a product, I watch my connection halt and it is gone and frees its slot', async () => {
    // Given
    const { tab, built } = startEngine();
    const chain = await tab.connect('0xaa', 'c1');
    haltTransport(must(built[0], 'transport'));
    await chain.ended;

    // When the tab sends on it, then fills its whole quota again
    const sent = await tab.send('c1', toGenesisRequest('q1'));
    const refilled: ChainRecording[] = [];
    for (let index = 0; index < MAX_CONNECTIONS; index++) {
      refilled.push(await tab.connect('0xaa', `n${String(index)}`));
    }

    // Then
    expect(sent).toEqual(toThrownAnswer('Unknown chain connection: c1'));
    expect(refilled.map(connected => connected.events)).toEqual(
      Array.from({ length: MAX_CONNECTIONS }, () => [CONNECTED]),
    );
  });

  it('As a product, I reconnect under the same id after a halt and get a fresh chain', async () => {
    // Given
    const { tab, built } = startEngine();
    const first = await tab.connect('0xaa', 'c1');
    haltTransport(must(built[0], 'transport'));
    await first.ended;

    // When
    const again = await tab.connect('0xaa', 'c1');
    await tab.send('c1', toGenesisRequest('q2'));

    // Then
    expect(again.events).toEqual([CONNECTED]);
    expect(built).toHaveLength(2);
    expect(must(built[1], 'rebuilt transport').sent).toHaveLength(1);
  });

  it('As a dotli user, I watch one chain die and my connections on other chains keep working', async () => {
    // Given
    const { tab, built } = startEngine();
    await tab.connect('0xaa', 'c1');
    await tab.connect('0xbb', 'c2');

    // When
    haltTransport(must(built[0], 'first chain'));
    await tab.send('c2', toGenesisRequest('q1'));

    // Then
    expect(must(built[1], 'second chain').sent).toHaveLength(1);
  });
});

describe('createEngine scopes', () => {
  it('As a dotli user on the shared light client, I send on my chain and its answers reach my tab and not another tab', async () => {
    // Given
    const { engine, built } = startEngine();
    const mine = openTab(engine);
    const theirs = openTab(engine);
    const heardByMine = await mine.connect('0xaa', 'c1');
    const heardByTheirs = await theirs.connect('0xaa', 'c1');

    // When
    await mine.send('c1', toGenesisRequest('q1'));
    const transport = must(built[0], 'transport');
    transport.emit({ jsonrpc: '2.0', id: must(transport.sent[0], 'request').id ?? null, result: '0xaa' });
    await heardByMine.waitFor(2);
    await theirs.send('c1', toGenesisRequest('q2'));

    // Then
    expect(heardByMine.events.map(event => event.tag)).toEqual(['connected', 'message']);
    expect(heardByTheirs.events.map(event => event.tag)).toEqual(['connected']);
  });

  it('As a dotli user on the shared light client, I watch another tab send on my connection and it is refused', async () => {
    // Given
    const { engine, built } = startEngine();
    const mine = openTab(engine);
    const theirs = openTab(engine);
    await mine.connect('0xaa', 'c1');

    // When the other tab sends on it, and then mine does
    const sent = await theirs.send('c1', toGenesisRequest('q1'));
    await mine.send('c1', toGenesisRequest('q2'));

    // Then
    expect(sent).toEqual(toThrownAnswer('Unknown chain connection: c1'));
    expect(must(built[0], 'transport').sent).toHaveLength(1);
  });

  it("As a dotli user on the shared light client, I open two tabs and each gets a tab's limit", async () => {
    // Given
    const { engine } = startEngine();
    const tabs = [openTab(engine), openTab(engine)];

    // When
    const connected = await Promise.all(
      tabs.flatMap((tab, t) =>
        Array.from({ length: MAX_CONNECTIONS }, (_, i) => tab.connect('0xaa', `t${String(t)}c${String(i)}`)),
      ),
    );

    // Then
    expect(connected.map(chain => chain.events)).toEqual(
      Array.from({ length: 2 * MAX_CONNECTIONS }, () => [CONNECTED]),
    );
  });

  it('As a dotli user on the shared light client, I disconnect one connection at my tab limit and can connect again', async () => {
    // Given a tab at its limit, whose next connect is refused
    const { tab } = startEngine();
    const chains: ChainRecording[] = [];
    for (let index = 0; index < MAX_CONNECTIONS; index++) {
      chains.push(await tab.connect('0xaa', `c${String(index)}`));
    }
    const refused = await (await tab.connect('0xaa', 'extra')).ended;

    // When it disconnects one and connects again
    must(chains[0], 'first chain').unsubscribe();
    const again = await tab.connect('0xaa', 'extra');

    // Then
    expect(refused).toEqual(toThrownAnswer('Connection limit reached (max 10)'));
    expect(again.events).toEqual([CONNECTED]);
  });

  it('As a dotli user on the shared light client, I close a tab and its connections end, release only them and free its limit', async () => {
    // Given
    const { engine, built } = startEngine({ destroyDelay: 0 });
    const closing = openTab(engine);
    const staying = openTab(engine);
    const first = await closing.connect('0xaa', 'c1');
    const second = await staying.connect('0xbb', 'c2');

    // When the first tab closes
    closing.scope.close();

    // Then its connection ends and its chain is released, and the other tab's is not
    expect(await first.ended).toEqual(ok());
    expect(must(built[0], 'first chain').disconnect).toHaveBeenCalledTimes(1);
    expect(must(built[1], 'second chain').disconnect).not.toHaveBeenCalled();

    // When the other tab sends, and the closed tab fills its whole limit again
    await staying.send('c2', toGenesisRequest('q1'));
    const refilled: ChainRecording[] = [];
    for (let index = 0; index < MAX_CONNECTIONS; index++) {
      refilled.push(await closing.connect('0xaa', `again${String(index)}`));
    }

    // Then the other tab's connection still holds, and the closed tab got its limit back
    expect(second.events).toEqual([CONNECTED]);
    expect(refilled.map(connected => connected.events)).toEqual(
      Array.from({ length: MAX_CONNECTIONS }, () => [CONNECTED]),
    );
  });

  it('As the frame, I close a scope while a disconnect throws, and the failure is reported, not thrown', async () => {
    // Given two connections, the first of whose disconnect throws
    const reports = recordReports({ onFinished: onTestFinished });
    const pool = spyOnPool();
    const { tab } = startEngine({ wrapPool: pool.wrap });
    pool.failNextDisconnect(new Error('disconnect failed'));
    const first = await tab.connect('0xaa', 'c1');
    const second = await tab.connect('0xbb', 'c2');

    // When
    const thrown = catchError(tab.scope.close);

    // Then
    expect(thrown).toBeUndefined();
    expect(reports.exceptions).toMatchObject([{ step: 'disconnect' }]);
    expect(await first.ended).toEqual(ok());
    expect(await second.ended).toEqual(ok());
  });

  it('As a dotli user on the shared light client, I close a tab after its chain died and only what is left is released', async () => {
    // Given
    const { tab, built } = startEngine({ destroyDelay: 0 });
    await tab.connect('0xaa', 'c1');
    await tab.connect('0xbb', 'c2');
    const died = must(built[0], 'first chain');
    haltTransport(died);
    const diedDisconnects = died.disconnect.mock.calls.length;

    // When the tab closes, and closes again
    tab.scope.close();
    tab.scope.close();

    // Then
    expect(died.disconnect).toHaveBeenCalledTimes(diedDisconnects);
    expect(must(built[1], 'second chain').disconnect).toHaveBeenCalledTimes(1);
  });
});
