// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { FrameStatus } from './createFrameStatus.js';
import { beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import { bindRecordingSentry, recordReports, type RecordedReport, type RecordingSentry } from '@dotli/metrics/testing';
import { createDeferred, isRecord } from '@dotli/shared';
import { createManualTimers, type ManualTimers, recordLog } from '@dotli/shared/testing';
import type { RemoteChainHalt } from '@dotli/chains';
import { err, hostFailure, ok, type MethodTypes, type Sink } from '@dotli/transport';
import { ProtocolFatalError } from './errors.js';
import { getBudget } from './methodPolicy.js';
import { createRemoteChains, type RemoteChainProvider } from './createRemoteChains.js';
import { createFrameRpc } from './createFrameRpc.js';
import { createFakeFrame, type FakeFrame } from './createProtocolFrame.fake.js';
import { protocolSchema, type ProtocolTransport, type RemoteFailure, type SubscriptionEnd } from './schema.js';
import { FRAME_CONFIG } from './testing/constants.js';
import { createFrameHost, type FrameHost } from './testing/createFrameHost.js';

const { chain } = protocolSchema.sections;

type Connect = MethodTypes<typeof chain.connect>;

const CONNECT_BUDGET_MS = getBudget(chain.connect) ?? 0;

/** The clock and timers each test moves by hand. */
let timers: ManualTimers;

/** Lets queued waits and answers settle. */
function settle(ms = 0): Promise<void> {
  return timers.advance(ms);
}

type ServedConnect = {
  payload: Connect['start'];
  sink: Sink<Connect['receive'], SubscriptionEnd<RemoteFailure>>;
  /** The host unsubscribed, which is its disconnect. */
  stopped: boolean;
};

type ServedSend = {
  connectionId: string;
  message: string;
  answer: { resolve: (value: undefined) => void; reject: (reason: Error) => void };
};

/** A frame app's side of chain connections: what it was asked, and the sinks and answers to reply with. */
type ChainServer = {
  connects: ServedConnect[];
  sends: ServedSend[];
};

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
    const answer = createDeferred<undefined>();
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
function readSentIds(server: ChainServer): unknown[] {
  return server.sends.map(send => {
    const request: unknown = JSON.parse(send.message);
    return isRecord(request) ? request['id'] : undefined;
  });
}

/** Every exception this test captures with its step, error and tags, and every metric it counts. */
function recordExceptionsAndCounts(): { captured: RecordedReport[]; metrics: RecordingSentry } {
  const captured = recordReports({ onFinished: onTestFinished }).exceptions;
  return { captured, metrics: bindRecordingSentry({ onFinished: onTestFinished }) };
}

function createGenesisRequest(id: number): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method: 'chainSpec_v1_genesisHash', params: [] };
}

function createClosedAnswer(id: number): JsonRpcMessage {
  return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Chain connection is closed' } };
}

function createHaltedAnswer(id: number): JsonRpcMessage {
  return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' } };
}

describe('createRemoteChains', () => {
  let fake: FakeFrame;
  let servers: ChainServer[];
  let people: RemoteChainProvider;

  /** The chain server of the frame up now. */
  function getServer(): ChainServer {
    const current = servers.at(-1);
    if (current === undefined) {
      throw new Error('no frame was built');
    }
    return current;
  }

  beforeEach(() => {
    timers = createManualTimers();
    servers = [];
    fake = createFakeFrame({
      serve: serving => {
        servers.push(serveChains(serving));
      },
      timers,
    });
    const chains = createRemoteChains({ rpc: createFrameRpc({ frame: fake.frame, timers }) });
    const provider = chains.createProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }
    people = provider;
  });

  it('As a product, I send before my connection is accepted and my sends wait for connected and go out in order', async () => {
    // Given a connection the frame has not accepted yet, with sends made meanwhile
    const connection = people(() => undefined);
    connection.send(createGenesisRequest(1));
    connection.send(createGenesisRequest(2));
    await settle();
    const sentBeforeConnected = readSentIds(getServer());
    connection.send(createGenesisRequest(3));

    // When
    accept(getServer().connects[0]);
    await settle();
    connection.send(createGenesisRequest(4));
    await settle();

    // Then
    expect(sentBeforeConnected).toEqual([]);
    expect(readSentIds(getServer())).toEqual([1, 2, 3, 4]);
    expect(getServer().connects.map(connect => connect.payload.genesisHash)).toEqual([
      getActiveServicesConfig().people.genesis,
    ]);
    expect(new Set(getServer().sends.map(send => send.connectionId))).toEqual(
      new Set([getServer().connects[0]?.payload.connectionId]),
    );
  });

  it('As a product, I hear the chain messages of my connection', async () => {
    // Given
    const received: JsonRpcMessage[] = [];
    people(message => received.push(message));
    await settle();
    accept(getServer().connects[0]);

    // When
    getServer().connects[0]?.sink.send({
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
    accept(getServer().connects[0]);
    await settle();

    // When it is closed while the frame sends a message for it
    connection.disconnect();
    getServer().connects[0]?.sink.send({
      tag: 'message',
      value: JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }),
    });
    await settle();

    // Then
    expect(received).toEqual([]);
    expect(warnings).toEqual([]);
    expect(getServer().connects[0]?.stopped).toBe(true);
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
    expect(sentry.counted('protocol.request')).toEqual([
      { outcome: 'error', method: 'chainConnect', reason: 'ChainDisconnectedError' },
    ]);
    expect(sentry.distributions.filter(metric => metric.name === 'dotli.protocol.request')).toHaveLength(1);
  });

  it('As a dotli integrator, I receive a malformed chain message and it is reported and counted as a failure while the consumer hears nothing', async () => {
    // Given a live connection and a recorder of captured exceptions and logged errors
    const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
    const captures = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const received: JsonRpcMessage[] = [];
    people(message => received.push(message));
    await settle();
    accept(getServer().connects[0]);

    // When the frame sends a message that is not JSON
    getServer().connects[0]?.sink.send({ tag: 'message', value: '{' });
    await settle();

    // Then
    expect(received).toEqual([]);
    expect(captures).toMatchObject([{ step: 'chain_message_parse', tags: undefined }]);
    expect(errors.map(line => line.message)).toEqual([
      // An asymmetric matcher is typed any.
      expect.stringMatching(/chain-message JSON parse failed/) as string,
    ]);
    expect(metrics.counted('protocol.chain_message')).toEqual([{ outcome: 'error', reason: 'SyntaxError' }]);
  });

  it('As a dotli integrator, I open a connection the frame refuses and the failed connect is reported and counted once', async () => {
    // Given a connection the frame has not answered yet
    const expected = recordReports({ onFinished: onTestFinished }).expected;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    people(() => undefined);
    await settle();

    // When
    getServer().connects[0]?.sink.interrupt(err(hostFailure('Error: Too many chain connections')));
    await settle();

    // Then
    expect(expected).toMatchObject([{ step: 'remote_chain_connect' }]);
    expect(metrics.counted('protocol.remote_chain_connect')).toHaveLength(1);
  });

  it('As a product, I send a request the frame refuses and I hear it answered as an error while the failure is reported and counted', async () => {
    // Given a live connection
    const expected = recordReports({ onFinished: onTestFinished }).expected;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const received: JsonRpcMessage[] = [];
    const connection = people(message => received.push(message));
    await settle();
    accept(getServer().connects[0]);
    await settle();
    connection.send(createGenesisRequest(5));
    await settle();

    // When
    getServer().sends[0]?.answer.reject(new Error('send broke'));
    await settle();

    // Then
    expect(received).toMatchObject([{ jsonrpc: '2.0', id: 5, error: {} }]);
    expect(expected).toMatchObject([{ step: 'remote_chain_send' }]);
    expect(metrics.counted('protocol.remote_chain_send')).toEqual([
      { outcome: 'error', reason: 'ProtocolResponseError' },
    ]);
  });

  it('As a product, I connect while the frame is down, the connection waits for the boot it asked for, and halts as a dead frame if that boot fails', async () => {
    // Given
    fake.lose(new ProtocolFatalError('boom'));
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();

    // When
    people(() => undefined, onHalt);
    await settle();
    const statusWhileWaiting = fake.frame.status.get();
    const haltsWhileWaiting = onHalt.mock.calls.length;
    fake.lose(new Error('again'));
    await settle();

    // Then
    expect(statusWhileWaiting).toBe('booting');
    expect(haltsWhileWaiting).toBe(0);
    expect(onHalt.mock.calls).toEqual([['frame']]);
    expect(servers.flatMap(each => each.connects)).toEqual([]);
  });

  it('As a dotli integrator, I see a chain halt close only its own connection, and a lost frame close the rest once', async () => {
    // Given
    const chainHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const frameHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const received: JsonRpcMessage[] = [];
    people(() => undefined, chainHalt);
    const survivor = people(message => received.push(message), frameHalt);
    await settle();
    for (const connect of getServer().connects) {
      accept(connect);
    }
    await settle();

    // When
    getServer().connects[0]?.sink.interrupt(ok());
    await settle();
    fake.lose(new ProtocolFatalError('boom'));
    survivor.send(createGenesisRequest(2));

    // Then
    expect(chainHalt.mock.calls).toEqual([['chain']]);
    expect(frameHalt.mock.calls).toEqual([['frame']]);
    expect(received).toEqual([createClosedAnswer(2)]);
  });

  it('As a product, I see a chain the frame accepts after my connect budget disconnected', async () => {
    // Given a frame too busy to accept a connect within its budget
    const expected = recordReports({ onFinished: onTestFinished }).expected;
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const received: JsonRpcMessage[] = [];
    const connection = people(message => received.push(message), onHalt);
    await settle();
    const connect = getServer().connects[0];

    // When the budget runs out, and the frame accepts it afterwards
    await settle(CONNECT_BUDGET_MS);
    connect?.sink.send({ tag: 'connected', value: undefined });
    await settle();
    connection.send(createGenesisRequest(1));

    // Then the unsubscribe reached the frame, the late accept opened nothing, and the connection halted once
    expect(connect?.stopped).toBe(true);
    expect(onHalt.mock.calls).toEqual([['frame']]);
    expect(received).toEqual([createClosedAnswer(1)]);
    expect(getServer().sends).toEqual([]);
    expect(expected).toMatchObject([{ step: 'remote_chain_connect' }]);
  });

  it('As a dotli integrator, I send from my halt listener and the send is answered at once as closed', async () => {
    // Given an open connection with a request queued before connected, whose halt listener sends
    const received: JsonRpcMessage[] = [];
    const connection: JsonRpcConnection = people(
      message => received.push(message),
      () => {
        connection.send(createGenesisRequest(9));
      },
    );
    connection.send(createGenesisRequest(4));
    await settle();

    // When the chain halts cleanly
    getServer().connects[0]?.sink.interrupt(ok());
    await settle();

    // Then
    expect(received).toEqual([createHaltedAnswer(4), createClosedAnswer(9)]);
    expect(getServer().sends).toEqual([]);
  });

  it('As a product, I send to a chain that just halted and the refusal is ignored', async () => {
    // Given a send the frame has not answered yet
    const logError = recordLog({ onFinished: onTestFinished, level: 'error' });
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const received: JsonRpcMessage[] = [];
    const connection = people(message => received.push(message), onHalt);
    await settle();
    accept(getServer().connects[0]);
    await settle();
    connection.send({ jsonrpc: '2.0', id: 3, method: 'chainHead_v1_follow', params: [true] });
    await settle();

    // When the chain halts, then the frame refuses the send for a connection it forgot
    getServer().connects[0]?.sink.interrupt(ok());
    await settle();
    getServer().sends[0]?.answer.reject(new Error('Unknown chain connection'));
    await settle();

    // Then
    expect(onHalt.mock.calls).toEqual([['chain']]);
    expect(received).toEqual([]);
    expect(logError).toEqual([]);
  });

  it("As a dotli integrator, I see a chain connection's sends not timed as protocol requests, while its connect is", async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    function countTimedRequests(): number {
      return sentry.distributions.filter(metric => metric.name === 'dotli.protocol.request').length;
    }
    const connection = people(() => undefined);
    await settle();
    accept(getServer().connects[0]);
    await settle();
    const afterConnect = countTimedRequests();

    // When the sends go out and the frame acknowledges each
    connection.send(createGenesisRequest(1));
    connection.send(createGenesisRequest(2));
    await settle();
    for (const send of getServer().sends) {
      send.answer.resolve(undefined);
    }
    await settle();

    // Then
    expect(getServer().sends).toHaveLength(2);
    expect(afterConnect).toBe(1);
    expect(countTimedRequests()).toBe(1);
  });
});

// Each test's own client, so nothing an earlier test left running reaches it.
let host: FrameHost;

function createPeopleProvider(): RemoteChainProvider {
  const provider = host.client.chains.createProvider(getActiveServicesConfig().people.genesis);
  if (provider === null) {
    throw new Error('People is not remote-connectable');
  }
  return provider;
}

type Frame = {
  status: FrameStatus;
  chains: ChainServer;
};

/** Serves the client's current protocol iframe and reports it ready. */
async function bootFrame(): Promise<Frame> {
  const chains = serveChains(host.serve());
  return { status: await host.bringUp(), chains };
}

type Remote = {
  frame: Frame;
  received: JsonRpcMessage[];
  connection: JsonRpcConnection;
  connect: ServedConnect;
};

/** Opens another connection against a frame that is already up, and the frame accepts it. */
async function connectMore(frame: Frame, onHalt?: (reason: RemoteChainHalt) => void): Promise<Remote> {
  const received: JsonRpcMessage[] = [];
  const known = frame.chains.connects.length;
  const connection = createPeopleProvider()(message => received.push(message), onHalt);
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
  const connection = createPeopleProvider()(message => received.push(message), onHalt);
  const frame = await bootFrame();
  const connect = frame.chains.connects[0];
  accept(connect);
  await settle();
  if (connect === undefined) {
    throw new Error('no chainConnect reached the frame');
  }
  return { frame, received, connection, connect };
}

describe('chains.createProvider halts', () => {
  beforeEach(() => {
    timers = createManualTimers();
    host = createFrameHost({ config: FRAME_CONFIG, timers });
  });

  it('As a dotli integrator, I see a chain halt answer what a connection had not sent yet with a halt it can retry', async () => {
    // Given
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const received: JsonRpcMessage[] = [];
    const connection = createPeopleProvider()(message => received.push(message), onHalt);
    connection.send(createGenesisRequest(4));
    const frame = await bootFrame();

    // When
    frame.chains.connects[0]?.sink.interrupt(ok());
    await settle();

    // Then
    expect(received).toEqual([createHaltedAnswer(4)]);
    expect(onHalt.mock.calls).toEqual([['chain']]);
  });

  it('As a dotli integrator, I see a halt listener that throws reported while the connection still closes', async () => {
    // Given
    const { captured, metrics } = recordExceptionsAndCounts();
    const bug = new Error('listener bug');
    const { received, connection, connect } = await connectRemote(() => {
      throw bug;
    });

    // When
    connect.sink.interrupt(ok());
    await settle();
    connection.send(createGenesisRequest(9));

    // Then
    expect(captured).toMatchObject([{ step: 'listener', error: bug, tags: { owner: 'remote_chain.halt' } }]);
    expect(metrics.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'remote_chain.halt' },
    ]);
    expect(received).toEqual([createClosedAnswer(9)]);
  });

  it('As a dotli integrator, I close a connection before its chain halts and it hears nothing, while an open one still does', async () => {
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
    host.client.frame.status.listen(next => {
      if (next === 'idle' && dialled === null) {
        dialled = createPeopleProvider()(message => received.push(message), onHalt);
      }
    });

    // When the host configures a new mode and the new frame reports ready
    host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const rebuilt = await bootFrame();

    // Then that connection was never halted, and its connect reached the new frame
    expect(dialled).not.toBeNull();
    expect(onHalt).not.toHaveBeenCalled();
    expect(received).toEqual([]);
    expect(rebuilt.chains.connects).toHaveLength(1);
  });

  it('As a dotli integrator, I see a consumer that throws while its queued send is closed, and the other consumers still halt', async () => {
    // Given
    const { captured, metrics } = recordExceptionsAndCounts();
    const bug = new Error('consumer bug');
    const throwing = createPeopleProvider()(() => {
      throw bug;
    });
    throwing.send(createGenesisRequest(1));
    const frame = await bootFrame();
    const dead = host.getIframe();
    const secondHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    createPeopleProvider()(() => undefined, secondHalt);
    await settle();

    // When
    frame.status.fail(new ProtocolFatalError('boom'));
    await settle();

    // Then
    expect(captured).toMatchObject([
      { step: 'frame_lost' },
      { step: 'listener', tags: { owner: 'remote_chain.message' } },
    ]);
    expect(captured.map(report => report.error)).toEqual([expect.any(ProtocolFatalError), bug]);
    expect(metrics.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'remote_chain.message' },
    ]);
    expect(secondHalt.mock.calls).toEqual([['frame']]);
    expect(dead.isConnected).toBe(false);
  });

  it('As a dotli integrator, I lose the frame under an unacknowledged send and the send is neither logged nor answered', async () => {
    // Given
    const logError = recordLog({ onFinished: onTestFinished, level: 'error' });
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const { frame, received, connection } = await connectRemote(onHalt);
    connection.send(createGenesisRequest(3));
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

  it('As a dotli integrator, I close a connection while its frame boots and it never reaches the frame, and is not counted', async () => {
    // Given a connection with a send queued, closed before its frame is up
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const received: JsonRpcMessage[] = [];
    const connection = createPeopleProvider()(message => received.push(message));
    connection.send(createGenesisRequest(1));
    connection.disconnect();

    // When the frame comes up
    const frame = await bootFrame();
    await settle();

    // Then nothing reached it, not even its connect
    expect(frame.chains.connects).toEqual([]);
    expect(frame.chains.sends).toEqual([]);
    expect(received).toEqual([]);
    expect(sentry.counted('protocol.request')).toEqual([]);
  });

  it('As a dotli integrator, I close a connection before the frame accepts it and it is closed in the frame, and sends nothing', async () => {
    // Given a connection with a send queued, whose connect the frame has not accepted yet
    const received: JsonRpcMessage[] = [];
    const connection = createPeopleProvider()(message => received.push(message));
    connection.send(createGenesisRequest(1));
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

  it('As a dotli integrator, I close a connection before the frame refuses it and it posts nothing more and logs nothing', async () => {
    // Given
    const logError = recordLog({ onFinished: onTestFinished, level: 'error' });
    const connection = createPeopleProvider()(() => undefined);
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

  it('As a dotli integrator, I open a connection the frame refuses and it halts as a dead frame', async () => {
    // Given a send queued before the frame answers the connect
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const received: JsonRpcMessage[] = [];
    const connection = createPeopleProvider()(message => received.push(message), onHalt);
    connection.send(createGenesisRequest(6));
    const frame = await bootFrame();

    // When
    frame.chains.connects[0]?.sink.interrupt(err(hostFailure('Error: Too many chain connections')));
    await settle();
    connection.send(createGenesisRequest(7));

    // Then
    expect(onHalt.mock.calls).toEqual([['frame']]);
    expect(received).toEqual([createClosedAnswer(6), createClosedAnswer(7)]);
  });
});
