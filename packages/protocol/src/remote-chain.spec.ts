// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { FrameStatus } from './frame-status.js';
import { beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import { spans as S } from '@dotli/metrics';
import {
  bindRecordingSentry,
  recordCaptures,
  type RecordedCapture,
  type RecordingSentry,
} from '@dotli/metrics/testing';
import { deferred } from '@dotli/shared';
import { manualTimers, type ManualTimers, recordLog } from '@dotli/shared/testing';
import type { RemoteChainHalt } from '@dotli/chains';
import { err, hostFailure, ok, type MethodTypes, type Sink } from '@dotli/transport';
import { ProtocolFatalError } from './errors.js';
import { budgetOf } from './method-policy.js';
import { createRemoteChains, type RemoteChainProvider } from './remote-chain.js';
import { createFrameRpc } from './rpc.js';
import { createFakeFrame, type FakeFrame } from './frame.fake.js';
import { protocolSchema, type ProtocolTransport, type RemoteFailure, type SubscriptionEnd } from './schema.js';
import { createFrameHost, FRAME_CONFIG, type FrameHost } from './testing/frame-host.js';

const { chain } = protocolSchema.sections;

type Connect = MethodTypes<typeof chain.connect>;

const CONNECT_BUDGET_MS = budgetOf(chain.connect) ?? 0;

/** The clock and timers each test moves by hand. */
let timers: ManualTimers;

/** Lets queued waits and answers settle. */
const settle = (ms = 0): Promise<void> => timers.advance(ms);

interface ServedConnect {
  payload: Connect['start'];
  sink: Sink<Connect['receive'], SubscriptionEnd<RemoteFailure>>;
  /** The host unsubscribed, which is its disconnect. */
  stopped: boolean;
}

interface ServedSend {
  connectionId: string;
  message: string;
  answer: { resolve: (value: undefined) => void; reject: (reason: Error) => void };
}

/** A frame app's side of chain connections: what it was asked, and the sinks and answers to reply with. */
interface ChainServer {
  connects: ServedConnect[];
  sends: ServedSend[];
}

function serveChains(serving: ProtocolTransport): ChainServer {
  const server: ChainServer = { connects: [], sends: [] };
  serving.handleSubscription(chain.connect, (payload, _context, sink) => {
    const connect: ServedConnect = { payload, sink, stopped: false };
    server.connects.push(connect);
    return () => {
      connect.stopped = true;
    };
  });
  serving.handleRequest(chain.send, ({ connectionId, message }) => {
    const answer = deferred<undefined>();
    server.sends.push({ connectionId, message, answer });
    return answer.promise.then(() => ok());
  });
  return server;
}

function accept(connect: ServedConnect | undefined): void {
  if (connect === undefined) {
    throw new Error('no chainConnect reached the frame');
  }
  connect.sink.send({ tag: 'connected', value: undefined });
}

/** The JSON-RPC ids of the sends that reached the frame, in order. */
function sentIds(server: ChainServer): unknown[] {
  return server.sends.map(send => (JSON.parse(send.message) as { id: unknown }).id);
}

/** Every exception this test captures with its step and tags, the errors themselves, and every metric it counts. */
function recordReports(): { captured: RecordedCapture[]; errors: unknown[]; metrics: RecordingSentry } {
  const errors: unknown[] = [];
  const captured = recordCaptures({ onFinished: onTestFinished, errors });
  return { captured, errors, metrics: bindRecordingSentry({ onFinished: onTestFinished }) };
}

const genesisRequest = (id: number): JsonRpcRequest => ({
  jsonrpc: '2.0',
  id,
  method: 'chainSpec_v1_genesisHash',
  params: [],
});

const closed = (id: number): JsonRpcMessage => ({
  jsonrpc: '2.0',
  id,
  error: { code: -32603, message: 'Chain connection is closed' },
});

describe('createRemoteChains', () => {
  let fake: FakeFrame;
  let servers: ChainServer[];
  let people: RemoteChainProvider;

  /** The chain server of the frame up now. */
  const server = (): ChainServer => {
    const current = servers.at(-1);
    if (current === undefined) {
      throw new Error('no frame was built');
    }
    return current;
  };

  beforeEach(() => {
    timers = manualTimers();
    servers = [];
    fake = createFakeFrame(
      serving => {
        servers.push(serveChains(serving));
      },
      { timers },
    );
    const chains = createRemoteChains(createFrameRpc(fake.frame, timers));
    const provider = chains.createRemoteChainProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }
    people = provider;
  });

  it('As a product, my sends wait for connected and go out in order', async () => {
    // Given a connection the frame has not accepted yet, with sends made meanwhile
    const connection = people(() => undefined);
    connection.send(genesisRequest(1));
    connection.send(genesisRequest(2));
    await settle();
    const sentBeforeConnected = sentIds(server());
    connection.send(genesisRequest(3));

    // When
    accept(server().connects[0]);
    await settle();
    connection.send(genesisRequest(4));
    await settle();

    // Then
    expect(sentBeforeConnected).toEqual([]);
    expect(sentIds(server())).toEqual([1, 2, 3, 4]);
    expect(server().connects.map(connect => connect.payload.genesisHash)).toEqual([
      getActiveServicesConfig().people.genesis,
    ]);
    expect(new Set(server().sends.map(send => send.connectionId))).toEqual(
      new Set([server().connects[0]?.payload.connectionId]),
    );
  });

  it('As a product, I hear the chain messages of my connection', async () => {
    // Given
    const received: JsonRpcMessage[] = [];
    people(message => received.push(message));
    await settle();
    accept(server().connects[0]);

    // When
    server().connects[0]?.sink.send({
      tag: 'message',
      value: JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }),
    });
    await settle();

    // Then
    expect(received).toEqual([{ jsonrpc: '2.0', id: 1, result: '0x' }]);
  });

  it('As a dotli integrator, I disconnect a connection and a chain message still on its way is dropped without a warning', async () => {
    // Given a connection the frame accepted
    const warnings = recordLog({ onFinished: onTestFinished, level: 'warn' });
    const received: JsonRpcMessage[] = [];
    const connection = people(message => received.push(message));
    await settle();
    accept(server().connects[0]);
    await settle();

    // When it is closed while the frame sends a message for it
    connection.disconnect();
    server().connects[0]?.sink.send({
      tag: 'message',
      value: JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }),
    });
    await settle();

    // Then
    expect(received).toEqual([]);
    expect(warnings).toEqual([]);
    expect(server().connects[0]?.stopped).toBe(true);
  });

  it('As a product, I disconnect before the frame accepts my connect, and the connect is settled once as a disconnect', async () => {
    // Given a connect the frame has not accepted yet
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const connection = people(() => undefined);
    await settle();

    // When I disconnect, and the connect budget runs out afterwards
    connection.disconnect();
    await settle(CONNECT_BUDGET_MS);

    // Then
    expect(sentry.counted(S.PROTOCOL_REQUEST)).toEqual([
      { outcome: 'error', method: 'chainConnect', reason: 'ChainDisconnectedError' },
    ]);
    expect(sentry.distributions.filter(metric => metric.name === `dotli.${S.PROTOCOL_REQUEST}`)).toHaveLength(1);
  });

  it('As a dotli integrator, I receive a malformed chain message and it is reported and counted as a failure while the consumer hears nothing', async () => {
    // Given a live connection and a recorder of captured exceptions and logged errors
    const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
    const captures = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const received: JsonRpcMessage[] = [];
    people(message => received.push(message));
    await settle();
    accept(server().connects[0]);

    // When the frame sends a message that is not JSON
    server().connects[0]?.sink.send({ tag: 'message', value: '{' });
    await settle();

    // Then
    expect(received).toEqual([]);
    expect(captures).toEqual([{ flow: 'protocol', step: 'chain_message_parse', tags: undefined }]);
    expect(errors.map(line => line.message)).toEqual([
      expect.stringMatching(/chain-message JSON parse failed/) as string,
    ]);
    expect(metrics.counted(S.PROTOCOL_CHAIN_MESSAGE)).toEqual([{ outcome: 'error', reason: 'SyntaxError' }]);
  });

  it('As a product, I connect while the frame is down, the connection waits for the boot it asked for, and halts as a dead frame if that boot fails', async () => {
    // Given
    fake.lose(new ProtocolFatalError('boom'));
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();

    // When
    people(() => undefined, onHalt);
    await settle();
    const statusWhileWaiting = fake.frame.getStatus();
    const haltsWhileWaiting = onHalt.mock.calls.length;
    fake.lose(new Error('again'));
    await settle();

    // Then
    expect(statusWhileWaiting).toBe('booting');
    expect(haltsWhileWaiting).toBe(0);
    expect(onHalt.mock.calls).toEqual([['frame']]);
    expect(servers.flatMap(each => each.connects)).toEqual([]);
  });

  it('As a dotli integrator, a chain halt closes only its own connection, and a lost frame closes the rest once', async () => {
    // Given
    const chainHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const frameHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const received: JsonRpcMessage[] = [];
    people(() => undefined, chainHalt);
    const survivor = people(message => received.push(message), frameHalt);
    await settle();
    for (const connect of server().connects) {
      accept(connect);
    }
    await settle();

    // When
    server().connects[0]?.sink.interrupt(ok());
    await settle();
    fake.lose(new ProtocolFatalError('boom'));
    survivor.send(genesisRequest(2));

    // Then
    expect(chainHalt.mock.calls).toEqual([['chain']]);
    expect(frameHalt.mock.calls).toEqual([['frame']]);
    expect(received).toEqual([closed(2)]);
  });

  it('As a product, a chain accepted after my connect budget is disconnected', async () => {
    // Given a frame too busy to accept a connect within its budget
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const received: JsonRpcMessage[] = [];
    const connection = people(message => received.push(message), onHalt);
    await settle();
    const connect = server().connects[0];

    // When the budget runs out, and the frame accepts it afterwards
    await settle(CONNECT_BUDGET_MS);
    connect?.sink.send({ tag: 'connected', value: undefined });
    await settle();
    connection.send(genesisRequest(1));

    // Then the unsubscribe reached the frame, the late accept opened nothing, and the connection halted once
    expect(connect?.stopped).toBe(true);
    expect(onHalt.mock.calls).toEqual([['frame']]);
    expect(received).toEqual([closed(1)]);
    expect(server().sends).toEqual([]);
  });

  it('As a product, a refused send for a chain that just halted is ignored', async () => {
    // Given a send the frame has not answered yet
    const logError = recordLog({ onFinished: onTestFinished, level: 'error' });
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const received: JsonRpcMessage[] = [];
    const connection = people(message => received.push(message), onHalt);
    await settle();
    accept(server().connects[0]);
    await settle();
    connection.send({ jsonrpc: '2.0', id: 3, method: 'chainHead_v1_follow', params: [true] });
    await settle();

    // When the chain halts, then the frame refuses the send for a connection it forgot
    server().connects[0]?.sink.interrupt(ok());
    await settle();
    server().sends[0]?.answer.reject(new Error('Unknown chain connection'));
    await settle();

    // Then
    expect(onHalt.mock.calls).toEqual([['chain']]);
    expect(received).toEqual([]);
    expect(logError).toEqual([]);
  });

  it("As a dotli integrator, a chain connection's sends are not timed as protocol requests, while its connect is", async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const timedRequests = (): number =>
      sentry.distributions.filter(metric => metric.name === `dotli.${S.PROTOCOL_REQUEST}`).length;
    const connection = people(() => undefined);
    await settle();
    accept(server().connects[0]);
    await settle();
    const afterConnect = timedRequests();

    // When the sends go out and the frame acknowledges each
    connection.send(genesisRequest(1));
    connection.send(genesisRequest(2));
    await settle();
    for (const send of server().sends) {
      send.answer.resolve(undefined);
    }
    await settle();

    // Then
    expect(server().sends).toHaveLength(2);
    expect(afterConnect).toBe(1);
    expect(timedRequests()).toBe(1);
  });
});

// The client's wait before it rebuilds a frame that died.
const FRAME_REBUILD_INTERVAL_MS = 2_000;

// Each test's own client, so nothing an earlier test left running reaches it.
let host: FrameHost;

function peopleProvider(): RemoteChainProvider {
  const provider = host.client.createRemoteChainProvider(getActiveServicesConfig().people.genesis);
  if (provider === null) {
    throw new Error('People is not remote-connectable');
  }
  return provider;
}

interface Frame {
  status: FrameStatus;
  chains: ChainServer;
}

/** Serves the client's current protocol iframe and reports it ready. */
async function bootFrame(): Promise<Frame> {
  const chains = serveChains(host.serve());
  return { status: await host.bringUp(), chains };
}

interface Remote {
  frame: Frame;
  received: JsonRpcMessage[];
  connection: JsonRpcConnection;
  connect: ServedConnect;
}

/** Opens another connection against a frame that is already up, and the frame accepts it. */
async function connectMore(frame: Frame, onHalt?: (reason: RemoteChainHalt) => void): Promise<Remote> {
  const received: JsonRpcMessage[] = [];
  const known = frame.chains.connects.length;
  const connection = peopleProvider()(message => received.push(message), onHalt);
  await settle();
  const connect = frame.chains.connects[known];
  accept(connect);
  await settle();
  if (connect === undefined) {
    throw new Error('no chainConnect reached the frame');
  }
  return { frame, received, connection, connect };
}

/** Opens a connection, which boots the frame, and the frame accepts it. */
async function connectRemote(onHalt?: (reason: RemoteChainHalt) => void): Promise<Remote> {
  const received: JsonRpcMessage[] = [];
  const connection = peopleProvider()(message => received.push(message), onHalt);
  const frame = await bootFrame();
  const connect = frame.chains.connects[0];
  accept(connect);
  await settle();
  if (connect === undefined) {
    throw new Error('no chainConnect reached the frame');
  }
  return { frame, received, connection, connect };
}

describe('createRemoteChainProvider halts', () => {
  beforeEach(() => {
    timers = manualTimers();
    host = createFrameHost(undefined, FRAME_CONFIG, timers);
  });

  it('As a dotli integrator, a chain halt tells the connection once and closes it', async () => {
    // Given
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const { received, connection, connect } = await connectRemote(onHalt);

    // When
    connect.sink.interrupt(ok());
    await settle();
    connection.send(genesisRequest(7));

    // Then
    expect(onHalt.mock.calls).toEqual([['chain']]);
    expect(received).toEqual([closed(7)]);
  });

  it('As a dotli integrator, a chain halt answers what a connection had not sent yet with a halt it can retry', async () => {
    // Given
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const received: JsonRpcMessage[] = [];
    const connection = peopleProvider()(message => received.push(message), onHalt);
    connection.send(genesisRequest(4));
    const frame = await bootFrame();

    // When
    frame.chains.connects[0]?.sink.interrupt(ok());
    await settle();

    // Then
    expect(received).toEqual([
      {
        jsonrpc: '2.0',
        id: 4,
        error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
      },
    ]);
    expect(onHalt.mock.calls).toEqual([['chain']]);
  });

  it('As a dotli integrator, a halt listener that throws is reported and the connection still closes', async () => {
    // Given
    const { captured, errors, metrics } = recordReports();
    const bug = new Error('listener bug');
    const { received, connection, connect } = await connectRemote(() => {
      throw bug;
    });

    // When
    connect.sink.interrupt(ok());
    await settle();
    connection.send(genesisRequest(9));

    // Then
    expect(captured).toEqual([{ flow: 'protocol', step: 'listener', tags: { owner: 'remote_chain.halt' } }]);
    expect(errors).toEqual([bug]);
    expect(metrics.counted(S.LISTENER_DELIVERY)).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'remote_chain.halt' },
    ]);
    expect(received).toEqual([closed(9)]);
  });

  it('As a dotli integrator, a connection closed before its chain halts hears nothing, while an open one still does', async () => {
    // Given
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const openHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const closedRemote = await connectRemote(onHalt);
    const open = await connectMore(closedRemote.frame, openHalt);
    closedRemote.connection.disconnect();
    await settle();

    // When
    closedRemote.connect.sink.interrupt(ok());
    open.connect.sink.interrupt(ok());
    await settle();

    // Then
    expect(closedRemote.connect.stopped).toBe(true);
    expect(onHalt).not.toHaveBeenCalled();
    expect(openHalt.mock.calls).toEqual([['chain']]);
  });

  it("As a dotli integrator, I open a chain from a status listener on a config change's idle edge and it carries requests on the rebuilt frame", async () => {
    // Given a ready frame, and a status listener that dials once the frame goes idle
    await connectRemote();
    const onHalt = vi.fn<(reason: RemoteChainHalt) => void>();
    const received: JsonRpcMessage[] = [];
    let dialled: JsonRpcConnection | null = null;
    host.client.subscribeProtocolStatus(next => {
      if (next === 'idle' && dialled === null) {
        dialled = peopleProvider()(message => received.push(message), onHalt);
      }
    });

    // When the host configures a new mode and the new frame reports ready
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const rebuilt = await bootFrame();

    // Then that connection was never halted, and its connect reached the new frame
    expect(dialled).not.toBeNull();
    expect(onHalt).not.toHaveBeenCalled();
    expect(received).toEqual([]);
    expect(rebuilt.chains.connects).toHaveLength(1);
  });

  it('As a dotli integrator, a dead protocol frame halts every open chain connection once', async () => {
    // Given
    const firstHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const secondHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const first = await connectRemote(firstHalt);
    const second = await connectMore(first.frame, secondHalt);

    // When
    first.frame.status.fail(new ProtocolFatalError('boom'));
    await settle();
    first.connection.send(genesisRequest(1));
    second.connection.send(genesisRequest(2));

    // Then
    expect(firstHalt.mock.calls).toEqual([['frame']]);
    expect(secondHalt.mock.calls).toEqual([['frame']]);
    expect(first.received).toEqual([closed(1)]);
    expect(second.received).toEqual([closed(2)]);
  });

  it('As a dotli integrator, a dead protocol frame closes what a connection had not sent yet', async () => {
    // Given
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const received: JsonRpcMessage[] = [];
    const connection = peopleProvider()(message => received.push(message), onHalt);
    connection.send(genesisRequest(5));
    const frame = await bootFrame();

    // When
    frame.status.fail(new ProtocolFatalError('boom'));
    await settle();

    // Then
    expect(received).toEqual([closed(5)]);
    expect(onHalt.mock.calls).toEqual([['frame']]);
  });

  it('As a dotli integrator, I hear each time the protocol frame comes up, without starting one', async () => {
    // Given
    const readies: Mock<() => void> = vi.fn<() => void>();

    // When
    const unsubscribe = host.client.subscribeProtocolStatus(status => {
      if (status === 'ready') {
        readies();
      }
    });
    await settle();

    // Then
    expect(host.frames()).toBe(0);
    expect(readies).not.toHaveBeenCalled();

    // When
    const first = await connectRemote();

    // Then
    expect(readies).toHaveBeenCalledTimes(1);

    // When
    first.frame.status.fail(new ProtocolFatalError('boom'));
    await settle(FRAME_REBUILD_INTERVAL_MS);
    await connectRemote();

    // Then
    expect(readies).toHaveBeenCalledTimes(2);

    // When
    unsubscribe();
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await connectRemote();

    // Then
    expect(readies).toHaveBeenCalledTimes(2);
  });

  it('As a dotli integrator, I see the protocol frame booting while connections wait on it, and failed until it rebuilds itself', async () => {
    // Given
    const provider = peopleProvider();

    // Then
    expect(host.client.getProtocolStatus()).toBe('idle');
    expect(host.frames()).toBe(0);

    // When a connection starts a frame, and another connects while it boots
    provider(() => undefined);
    await settle();
    const booting = host.client.getProtocolStatus();
    provider(() => undefined);
    await settle();

    // Then both wait on the one frame
    expect(booting).toBe('booting');
    expect(host.frames()).toBe(1);

    // When
    const frame = await bootFrame();

    // Then
    expect(host.client.getProtocolStatus()).toBe('ready');
    expect(frame.chains.connects).toHaveLength(2);

    // When it dies, and the frame starts rebuilding it after its interval
    const dead = host.iframe();
    frame.status.fail(new ProtocolFatalError('boom'));
    await settle(FRAME_REBUILD_INTERVAL_MS - 1);
    const framesBeforeInterval = host.frames();
    const statusBeforeInterval = host.client.getProtocolStatus();
    await settle(1);

    // Then
    expect(dead.isConnected).toBe(false);
    expect(framesBeforeInterval).toBe(0);
    expect(statusBeforeInterval).toBe('failed');
    expect(host.frames()).toBe(1);
    expect(host.client.getProtocolStatus()).toBe('booting');
  });

  it('As a dotli integrator, a frame whose ready wait gave up reports failed and halts the connection waiting on it', async () => {
    // Given a connection starts a frame, which listens but never reports ready
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    peopleProvider()(() => undefined, onHalt);
    await host.listen();
    const booting = host.client.getProtocolStatus();

    // When its ready wait times out
    await settle(240_000);

    // Then
    expect(booting).toBe('listening');
    expect(onHalt.mock.calls).toEqual([['frame']]);
    expect(host.client.getProtocolStatus()).toBe('failed');
  });

  it('As a dotli integrator, a consumer that throws while its queued send is closed cannot stop the rest from halting', async () => {
    // Given
    const { captured, errors, metrics } = recordReports();
    const bug = new Error('consumer bug');
    const throwing = peopleProvider()(() => {
      throw bug;
    });
    throwing.send(genesisRequest(1));
    const frame = await bootFrame();
    const dead = host.iframe();
    const secondHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    peopleProvider()(() => undefined, secondHalt);
    await settle();

    // When
    frame.status.fail(new ProtocolFatalError('boom'));
    await settle();

    // Then
    expect(captured).toEqual([
      { flow: 'protocol', step: 'frame_lost' },
      { flow: 'protocol', step: 'listener', tags: { owner: 'remote_chain.message' } },
    ]);
    expect(errors).toEqual([expect.any(ProtocolFatalError), bug]);
    expect(metrics.counted(S.LISTENER_DELIVERY)).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'remote_chain.message' },
    ]);
    expect(secondHalt.mock.calls).toEqual([['frame']]);
    expect(dead.isConnected).toBe(false);
  });

  it('As a dotli integrator, a send still unacknowledged when the frame dies is neither logged nor answered', async () => {
    // Given
    const logError = recordLog({ onFinished: onTestFinished, level: 'error' });
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const { frame, received, connection } = await connectRemote(onHalt);
    connection.send(genesisRequest(3));
    await settle();

    // When
    frame.status.fail(new ProtocolFatalError('boom'));
    await settle();

    // Then the frame's own loss is the one error logged. The line carries no error object, as a failed send's would
    expect(onHalt.mock.calls).toEqual([['frame']]);
    expect(received).toEqual([]);
    expect(logError).toHaveLength(1);
    expect(logError.flatMap(line => line.args ?? []).filter(arg => arg instanceof Error)).toEqual([]);
  });

  it('As a dotli integrator, a connection closed while its frame boots never reaches the frame, and is not counted', async () => {
    // Given a connection with a send queued, closed before its frame is up
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const received: JsonRpcMessage[] = [];
    const connection = peopleProvider()(message => received.push(message));
    connection.send(genesisRequest(1));
    connection.disconnect();

    // When the frame comes up
    const frame = await bootFrame();
    await settle();

    // Then nothing reached it, not even its connect
    expect(frame.chains.connects).toEqual([]);
    expect(frame.chains.sends).toEqual([]);
    expect(received).toEqual([]);
    expect(sentry.counted(S.PROTOCOL_REQUEST)).toEqual([]);
  });

  it('As a dotli integrator, a connection closed before the frame accepts it is closed in the frame, and sends nothing', async () => {
    // Given a connection with a send queued, whose connect the frame has not accepted yet
    const received: JsonRpcMessage[] = [];
    const connection = peopleProvider()(message => received.push(message));
    connection.send(genesisRequest(1));
    const frame = await bootFrame();
    const connect = frame.chains.connects[0];

    // When it is closed, and the frame accepts it all the same
    connection.disconnect();
    connect?.sink.send({ tag: 'connected', value: undefined });
    await settle();

    // Then
    expect(connect?.stopped).toBe(true);
    expect(frame.chains.sends).toEqual([]);
    expect(received).toEqual([]);
  });

  it('As a dotli integrator, a connection closed before the frame refuses it posts nothing more and logs nothing', async () => {
    // Given
    const logError = recordLog({ onFinished: onTestFinished, level: 'error' });
    const connection = peopleProvider()(() => undefined);
    const frame = await bootFrame();
    const connect = frame.chains.connects[0];

    // When
    connection.disconnect();
    connect?.sink.interrupt(err(hostFailure('Error: Too many chain connections')));
    await settle();

    // Then
    expect(frame.chains.sends).toEqual([]);
    expect(logError).toEqual([]);
  });

  it('As a dotli integrator, a connection the frame refuses to open halts as a dead frame', async () => {
    // Given a send queued before the frame answers the connect
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const received: JsonRpcMessage[] = [];
    const connection = peopleProvider()(message => received.push(message), onHalt);
    connection.send(genesisRequest(6));
    const frame = await bootFrame();

    // When
    frame.chains.connects[0]?.sink.interrupt(err(hostFailure('Error: Too many chain connections')));
    await settle();
    connection.send(genesisRequest(7));

    // Then
    expect(onHalt.mock.calls).toEqual([['frame']]);
    expect(received).toEqual([closed(6), closed(7)]);
  });
});
