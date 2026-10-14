// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import { spans as S } from '@dotli/metrics';
import {
  bindRecordingSentry,
  recordCaptures,
  type RecordedCapture,
  type RecordingSentry,
} from '@dotli/metrics/testing';
import { bindLogSink } from '@dotli/shared';
import type { RemoteChainHalt } from '@dotli/chains';
import type { ProtocolEnvelope, ProtocolRequestEnvelope } from './messages.js';
import { createRemoteChains, type RemoteChainProvider } from './remote-chain.js';
import { createFrameRpc } from './rpc.js';
import { createFakeFrame, type FakeFrame } from './frame.fake.js';
import { createFrameHost, FRAME_CONFIG, type FrameHost } from './testing/frame-host.js';

/** Lets queued waits and answers settle. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe('createRemoteChains', () => {
  let fake: FakeFrame;
  let people: RemoteChainProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    fake = createFakeFrame();
    const chains = createRemoteChains({ frame: fake.frame, rpc: createFrameRpc(fake.frame) });
    const provider = chains.createRemoteChainProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }
    people = provider;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** The frame accepting every connect posted so far, returning their connection ids in order. */
  function acceptConnects(): string[] {
    const connects = fake.posted.filter(envelope => envelope.method === 'chainConnect');
    for (const connect of connects) {
      fake.send({ namespace: 'dotli:protocol', kind: 'response', id: connect.id, ok: true, result: true });
    }
    return connects.map(connect => (connect.payload as { connectionId: string }).connectionId);
  }

  it('As a product, I connect while the frame is down, the connection waits for the boot it asked for, and halts as a dead frame if that boot fails', async () => {
    // Given
    fake.lose(new Error('Fatal: boom'));
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();

    // When
    people(() => undefined, onHalt);
    await settle();
    const statusWhileWaiting = fake.frame.getStatus();
    const haltsWhileWaiting = onHalt.mock.calls.length;
    fake.lose(new Error('Init failed: again'));
    await settle();

    // Then
    expect(statusWhileWaiting).toBe('booting');
    expect(haltsWhileWaiting).toBe(0);
    expect(onHalt.mock.calls).toEqual([['frame']]);
    expect(fake.posted).toEqual([]);
  });

  it('As a dotli integrator, what a connection sends before the frame accepts it goes out once it does', async () => {
    // Given
    const connection = people(() => undefined);
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainSpec_v1_genesisHash', params: [] });
    await settle();

    // When
    acceptConnects();
    await settle();

    // Then
    expect(fake.posted.map(envelope => envelope.method)).toEqual(['chainConnect', 'chainSend']);
  });

  it('As a dotli integrator, a chain halt closes only its own connection, and a lost frame closes the rest once', async () => {
    // Given
    const chainHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const frameHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const received: JsonRpcMessage[] = [];
    people(() => undefined, chainHalt);
    const survivor = people(message => received.push(message), frameHalt);
    await settle();
    const [first] = acceptConnects();
    await settle();

    // When
    fake.send({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId: first ?? '' });
    fake.lose(new Error('Fatal: boom'));
    fake.lose(new Error('Fatal: again'));
    survivor.send({ jsonrpc: '2.0', id: 2, method: 'chainSpec_v1_genesisHash', params: [] });

    // Then
    expect(chainHalt.mock.calls).toEqual([['chain']]);
    expect(frameHalt.mock.calls).toEqual([['frame']]);
    expect(received).toEqual([
      { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'Chain connection is closed' } },
    ]);
  });
});

/** The arguments of every `log.error` call in this test. */
function recordLoggedErrors(): unknown[][] {
  const errors: unknown[][] = [];
  onTestFinished(
    bindLogSink({
      emit: (level, _message, _attrs, args = []) => {
        if (level === 'error') {
          errors.push(args);
        }
      },
    }),
  );
  return errors;
}

/** Every exception this test captures with its step and tags, the errors themselves, and every metric it counts. */
function recordReports(): { captured: RecordedCapture[]; errors: unknown[]; metrics: RecordingSentry } {
  const errors: unknown[] = [];
  const captured = recordCaptures({ onFinished: onTestFinished, errors });
  return { captured, errors, metrics: bindRecordingSentry({ onFinished: onTestFinished }) };
}

interface Frame {
  posted: ProtocolRequestEnvelope[];
  deliver: (envelope: ProtocolEnvelope) => void;
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

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

/** Boots the client's protocol iframe and returns a way to talk as it. */
async function bootFrame(): Promise<Frame> {
  await flush();
  const iframe = host.iframe();
  const frameWindow = iframe.contentWindow;
  if (frameWindow === null) {
    throw new Error('protocol iframe has no window');
  }
  const deliver = (envelope: ProtocolEnvelope): void => {
    host.deliver(envelope, iframe);
  };
  iframe.dispatchEvent(new Event('load'));
  await flush();
  deliver({ namespace: 'dotli:protocol', kind: 'ready' });
  await flush();
  return { posted: frameWindow.posted as ProtocolRequestEnvelope[], deliver };
}

interface Remote {
  frame: Frame;
  received: JsonRpcMessage[];
  connection: JsonRpcConnection;
  connectionId: string;
}

/** Opens another connection against a frame that is already booted. */
async function connectMore(frame: Frame, onHalt?: (reason: RemoteChainHalt) => void): Promise<Remote> {
  const provider = peopleProvider();
  const received: JsonRpcMessage[] = [];
  const known = frame.posted.length;
  const connection = provider(message => received.push(message), onHalt);
  await flush();
  const request = frame.posted.slice(known).find(envelope => envelope.method === 'chainConnect');
  if (request === undefined) {
    throw new Error('no chainConnect posted');
  }
  frame.deliver({ namespace: 'dotli:protocol', kind: 'response', id: request.id, ok: true, result: true });
  await flush();
  const { connectionId } = request.payload as { connectionId: string };
  return { frame, received, connection, connectionId };
}

async function connectRemote(onHalt?: (reason: RemoteChainHalt) => void): Promise<Remote> {
  const provider = peopleProvider();
  const received: JsonRpcMessage[] = [];
  const connection = provider(message => received.push(message), onHalt);
  const frame = await bootFrame();
  const request = frame.posted.find(envelope => envelope.method === 'chainConnect');
  if (request === undefined) {
    throw new Error('no chainConnect posted');
  }
  frame.deliver({ namespace: 'dotli:protocol', kind: 'response', id: request.id, ok: true, result: true });
  await flush();
  const { connectionId } = request.payload as { connectionId: string };
  return { frame, received, connection, connectionId };
}

describe('createRemoteChainProvider halts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    host = createFrameHost();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('As a dotli integrator, a chain-halt tells the connection once and closes it', async () => {
    // Given
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const { frame, received, connection, connectionId } = await connectRemote(onHalt);

    // When
    frame.deliver({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId });
    frame.deliver({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId });
    connection.send({ jsonrpc: '2.0', id: 7, method: 'chainSpec_v1_genesisHash', params: [] });

    // Then
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledWith('chain');
    expect(received).toEqual([
      { jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'Chain connection is closed' } },
    ]);
  });

  it('As a dotli integrator, a chain-halt answers what a connection had not sent yet with a halt it can retry', async () => {
    // Given
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const provider = peopleProvider();
    const received: JsonRpcMessage[] = [];
    const connection = provider(message => received.push(message), onHalt);
    connection.send({ jsonrpc: '2.0', id: 4, method: 'chainSpec_v1_genesisHash', params: [] });
    const frame = await bootFrame();
    const request = frame.posted.find(envelope => envelope.method === 'chainConnect');
    if (request === undefined) {
      throw new Error('no chainConnect posted');
    }
    const { connectionId } = request.payload as { connectionId: string };

    // When
    frame.deliver({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId });

    // Then
    expect(received).toEqual([
      {
        jsonrpc: '2.0',
        id: 4,
        error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
      },
    ]);
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledWith('chain');
  });

  it('As a dotli integrator, a halt listener that throws is reported and the connection still closes', async () => {
    // Given
    const { captured, errors, metrics } = recordReports();
    const bug = new Error('listener bug');
    const { frame, received, connection, connectionId } = await connectRemote(() => {
      throw bug;
    });

    // When
    frame.deliver({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId });
    connection.send({ jsonrpc: '2.0', id: 9, method: 'chainSpec_v1_genesisHash', params: [] });

    // Then
    expect(captured).toEqual([{ flow: 'protocol', step: 'listener', tags: { owner: 'remote_chain.halt' } }]);
    expect(errors).toEqual([bug]);
    expect(metrics.counted(S.LISTENER_DELIVERY)).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'remote_chain.halt' },
    ]);
    expect(received).toEqual([
      { jsonrpc: '2.0', id: 9, error: { code: -32603, message: 'Chain connection is closed' } },
    ]);
  });

  it('As a dotli integrator, a connection closed before its chain halts hears nothing, while an open one still does', async () => {
    // Given
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const openHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const closed = await connectRemote(onHalt);
    const open = await connectMore(closed.frame, openHalt);
    closed.connection.disconnect();
    await flush();
    const disconnect = closed.frame.posted.find(envelope => envelope.method === 'chainDisconnect');
    if (disconnect === undefined) {
      throw new Error('no chainDisconnect posted');
    }
    closed.frame.deliver({ namespace: 'dotli:protocol', kind: 'response', id: disconnect.id, ok: true, result: true });
    await flush();

    // When
    closed.frame.deliver({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId: closed.connectionId });
    closed.frame.deliver({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId: open.connectionId });

    // Then
    expect(onHalt).not.toHaveBeenCalled();
    expect(openHalt).toHaveBeenCalledTimes(1);
    expect(openHalt).toHaveBeenCalledWith('chain');
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
    expect(rebuilt.posted.filter(envelope => envelope.method === 'chainConnect')).toHaveLength(1);
  });

  it('As a dotli integrator, a dead protocol frame halts every open chain connection once', async () => {
    // Given
    const firstHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const secondHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const first = await connectRemote(firstHalt);
    const second = await connectMore(first.frame, secondHalt);

    // When
    first.frame.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    first.connection.send({ jsonrpc: '2.0', id: 1, method: 'chainSpec_v1_genesisHash', params: [] });
    second.connection.send({ jsonrpc: '2.0', id: 2, method: 'chainSpec_v1_genesisHash', params: [] });

    // Then
    expect(firstHalt).toHaveBeenCalledTimes(1);
    expect(firstHalt).toHaveBeenCalledWith('frame');
    expect(secondHalt).toHaveBeenCalledTimes(1);
    expect(secondHalt).toHaveBeenCalledWith('frame');
    expect(first.received).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Chain connection is closed' } },
    ]);
    expect(second.received).toEqual([
      { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'Chain connection is closed' } },
    ]);
  });

  it('As a dotli integrator, a dead protocol frame closes what a connection had not sent yet', async () => {
    // Given
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const provider = peopleProvider();
    const received: JsonRpcMessage[] = [];
    const connection = provider(message => received.push(message), onHalt);
    connection.send({ jsonrpc: '2.0', id: 5, method: 'chainSpec_v1_genesisHash', params: [] });
    const frame = await bootFrame();

    // When
    frame.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await flush();

    // Then
    expect(received).toEqual([
      { jsonrpc: '2.0', id: 5, error: { code: -32603, message: 'Chain connection is closed' } },
    ]);
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledWith('frame');
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
    await flush();

    // Then
    expect(host.frames()).toBe(0);
    expect(readies).not.toHaveBeenCalled();

    // When
    const first = await connectRemote();

    // Then
    expect(readies).toHaveBeenCalledTimes(1);

    // When
    first.frame.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await vi.advanceTimersByTimeAsync(FRAME_REBUILD_INTERVAL_MS);
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

    // When: a connection starts a frame, and another connects while it boots.
    provider(() => undefined);
    await flush();
    const booting = host.client.getProtocolStatus();
    provider(() => undefined);
    await flush();

    // Then: both wait on the one frame.
    expect(booting).toBe('booting');
    expect(host.frames()).toBe(1);

    // When
    const frame = await bootFrame();

    // Then
    expect(host.client.getProtocolStatus()).toBe('ready');
    expect(frame.posted.filter(envelope => envelope.method === 'chainConnect')).toHaveLength(2);

    // When: it dies, and the shared store starts rebuilding it after its interval.
    const dead = host.iframe();
    frame.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await vi.advanceTimersByTimeAsync(FRAME_REBUILD_INTERVAL_MS - 1);
    const framesBeforeInterval = host.frames();
    const statusBeforeInterval = host.client.getProtocolStatus();
    await vi.advanceTimersByTimeAsync(1);

    // Then
    expect(dead.isConnected).toBe(false);
    expect(framesBeforeInterval).toBe(0);
    expect(statusBeforeInterval).toBe('failed');
    expect(host.frames()).toBe(1);
    expect(host.client.getProtocolStatus()).toBe('booting');
  });

  it('As a dotli integrator, a frame whose ready wait gave up reports failed and halts the connection waiting on it', async () => {
    // Given: a connection starts a frame, which loads but never reports ready.
    const provider = peopleProvider();
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    provider(() => undefined, onHalt);
    await vi.advanceTimersByTimeAsync(0);
    host.iframe().dispatchEvent(new Event('load'));
    host.deliver({ namespace: 'dotli:protocol', kind: 'listening' });
    await vi.advanceTimersByTimeAsync(0);
    const booting = host.client.getProtocolStatus();

    // When: its ready wait times out.
    await vi.advanceTimersByTimeAsync(240_000);

    // Then
    expect(booting).toBe('listening');
    expect(onHalt).toHaveBeenCalledWith('frame');
    expect(host.client.getProtocolStatus()).toBe('failed');
  });

  it('As a dotli integrator, a consumer that throws while its queued send is closed cannot stop the rest from halting', async () => {
    // Given
    const { captured, errors, metrics } = recordReports();
    const bug = new Error('consumer bug');
    const provider = peopleProvider();
    const throwing = provider(() => {
      throw bug;
    });
    throwing.send({ jsonrpc: '2.0', id: 1, method: 'chainSpec_v1_genesisHash', params: [] });
    const frame = await bootFrame();
    const dead = host.iframe();
    const chainConnect = frame.posted.find(envelope => envelope.method === 'chainConnect');
    if (chainConnect === undefined) {
      throw new Error('no chainConnect posted');
    }
    const secondHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    peopleProvider()(() => undefined, secondHalt);
    await flush();

    // When
    frame.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await flush();

    // Then
    expect(captured).toEqual([{ flow: 'protocol', step: 'listener', tags: { owner: 'remote_chain.message' } }]);
    expect(errors).toEqual([bug]);
    expect(metrics.counted(S.LISTENER_DELIVERY)).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'remote_chain.message' },
    ]);
    expect(secondHalt).toHaveBeenCalledTimes(1);
    expect(secondHalt).toHaveBeenCalledWith('frame');
    expect(dead.isConnected).toBe(false);
  });

  it('As a dotli integrator, a send the frame refuses after its chain halted is neither logged nor answered', async () => {
    // Given: a re-follow sent while the halt was on its way
    const logError = recordLoggedErrors();
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const { frame, received, connection, connectionId } = await connectRemote(onHalt);
    connection.send({ jsonrpc: '2.0', id: 3, method: 'chainHead_v1_follow', params: [true] });
    await flush();
    const chainSend = frame.posted.find(envelope => envelope.method === 'chainSend');
    if (chainSend === undefined) {
      throw new Error('no chainSend posted');
    }

    // When: the halt arrives, then the frame refuses the send for a connection it forgot
    frame.deliver({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId });
    frame.deliver({
      namespace: 'dotli:protocol',
      kind: 'response',
      id: chainSend.id,
      ok: false,
      error: 'Unknown chain connection',
    });
    await flush();

    // Then
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);
    expect(logError).toEqual([]);
  });

  it('As a dotli integrator, a send still unacknowledged when the frame dies is neither logged nor answered', async () => {
    // Given
    const logError = recordLoggedErrors();
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const { frame, received, connection } = await connectRemote(onHalt);
    connection.send({ jsonrpc: '2.0', id: 3, method: 'chainSpec_v1_genesisHash', params: [] });
    await flush();

    // When
    frame.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await flush();

    // Then the frame's own fatal is the one error logged. The line carries no error object, as a failed send's would
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledWith('frame');
    expect(received).toEqual([]);
    expect(logError).toHaveLength(1);
    expect(logError.flat().filter(arg => arg instanceof Error)).toEqual([]);
  });

  it("As a dotli integrator, a chain connection's sends are not timed as protocol requests, while its connect is", async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { frame, connection } = await connectRemote();
    const timedRequests = (): number =>
      sentry.distributions.filter(metric => metric.name === `dotli.${S.PROTOCOL_REQUEST}`).length;
    const afterConnect = timedRequests();

    // When the sends are posted and the frame acknowledges each
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainSpec_v1_genesisHash', params: [] });
    connection.send({ jsonrpc: '2.0', id: 2, method: 'chainSpec_v1_genesisHash', params: [] });
    await flush();
    const sends = frame.posted.filter(envelope => envelope.method === 'chainSend');
    for (const send of sends) {
      frame.deliver({ namespace: 'dotli:protocol', kind: 'response', id: send.id, ok: true, result: true });
    }
    await flush();

    // Then
    expect(sends).toHaveLength(2);
    expect(afterConnect).toBe(1);
    expect(timedRequests()).toBe(1);
  });

  it('As a dotli integrator, a connection closed while its frame boots never reaches the frame', async () => {
    // Given: a connection with a send queued, closed before its frame is up.
    const provider = peopleProvider();
    const received: JsonRpcMessage[] = [];
    const connection = provider(message => received.push(message));
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainSpec_v1_genesisHash', params: [] });
    connection.disconnect();

    // When: the frame comes up.
    const frame = await bootFrame();
    await flush();

    // Then: nothing was posted for it, not even its connect.
    expect(frame.posted).toEqual([]);
    expect(received).toEqual([]);
  });

  it('As a dotli integrator, a connection closed after its connect was posted is closed in the frame once the frame accepts it, and sends nothing', async () => {
    // Given: a connection with a send queued, whose connect the frame has not answered yet.
    const provider = peopleProvider();
    const received: JsonRpcMessage[] = [];
    const connection = provider(message => received.push(message));
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainSpec_v1_genesisHash', params: [] });
    const frame = await bootFrame();
    const chainConnect = frame.posted.find(envelope => envelope.method === 'chainConnect');
    if (chainConnect === undefined) {
      throw new Error('no chainConnect posted');
    }

    // When: it is closed, and then the frame accepts the connection.
    connection.disconnect();
    frame.deliver({ namespace: 'dotli:protocol', kind: 'response', id: chainConnect.id, ok: true, result: true });
    await flush();

    // Then
    expect(frame.posted.map(envelope => envelope.method)).toEqual(['chainConnect', 'chainDisconnect']);
    expect(frame.posted.map(envelope => (envelope.payload as { connectionId: string }).connectionId)).toEqual([
      (chainConnect.payload as { connectionId: string }).connectionId,
      (chainConnect.payload as { connectionId: string }).connectionId,
    ]);
    expect(received).toEqual([]);
  });

  it('As a dotli integrator, a connection closed after its connect was posted, which the frame then refuses, posts nothing more', async () => {
    // Given
    const logError = recordLoggedErrors();
    const provider = peopleProvider();
    const connection = provider(() => undefined);
    const frame = await bootFrame();
    const chainConnect = frame.posted.find(envelope => envelope.method === 'chainConnect');
    if (chainConnect === undefined) {
      throw new Error('no chainConnect posted');
    }

    // When
    connection.disconnect();
    frame.deliver({
      namespace: 'dotli:protocol',
      kind: 'response',
      id: chainConnect.id,
      ok: false,
      error: 'Too many chain connections',
    });
    await flush();

    // Then
    expect(frame.posted.map(envelope => envelope.method)).toEqual(['chainConnect']);
    expect(logError).toEqual([]);
  });

  it('As a dotli integrator, a connection the frame refuses to open halts as a dead frame', async () => {
    // Given: a send queued before the frame answers the connect
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const provider = peopleProvider();
    const received: JsonRpcMessage[] = [];
    const connection = provider(message => received.push(message), onHalt);
    connection.send({ jsonrpc: '2.0', id: 6, method: 'chainSpec_v1_genesisHash', params: [] });
    const frame = await bootFrame();
    const chainConnect = frame.posted.find(envelope => envelope.method === 'chainConnect');
    if (chainConnect === undefined) {
      throw new Error('no chainConnect posted');
    }

    // When
    frame.deliver({
      namespace: 'dotli:protocol',
      kind: 'response',
      id: chainConnect.id,
      ok: false,
      error: 'Too many chain connections',
    });
    await flush();
    connection.send({ jsonrpc: '2.0', id: 7, method: 'chainSpec_v1_genesisHash', params: [] });

    // Then
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledWith('frame');
    expect(received).toEqual([
      { jsonrpc: '2.0', id: 6, error: { code: -32603, message: 'Chain connection is closed' } },
      { jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'Chain connection is closed' } },
    ]);
  });

  it('As a dotli integrator, a connection whose connect timed out is closed in the frame, so a late accept cannot hold a slot', async () => {
    // Given: a frame too busy to answer a connect within its budget
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const provider = peopleProvider();
    provider(() => undefined, onHalt);
    const frame = await bootFrame();
    const chainConnect = frame.posted.find(envelope => envelope.method === 'chainConnect');
    if (chainConnect === undefined) {
      throw new Error('no chainConnect posted');
    }
    const { connectionId } = chainConnect.payload as { connectionId: string };

    // When: the connect times out, and the frame accepts it afterwards
    await vi.advanceTimersByTimeAsync(30_000);
    frame.deliver({ namespace: 'dotli:protocol', kind: 'response', id: chainConnect.id, ok: true, result: true });
    await flush();

    // Then
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledWith('frame');
    expect(frame.posted.map(envelope => envelope.method)).toEqual(['chainConnect', 'chainDisconnect']);
    expect(frame.posted.map(envelope => (envelope.payload as { connectionId: string }).connectionId)).toEqual([
      connectionId,
      connectionId,
    ]);
  });

  it('As a dotli integrator, I disconnect while the connect is in flight and, once it times out, the frame is told to close it', async () => {
    // Given: a frame too busy to answer a connect within its budget
    const provider = peopleProvider();
    const connection = provider(() => undefined);
    const frame = await bootFrame();
    const chainConnect = frame.posted.find(envelope => envelope.method === 'chainConnect');
    if (chainConnect === undefined) {
      throw new Error('no chainConnect posted');
    }
    const { connectionId } = chainConnect.payload as { connectionId: string };

    // When: the consumer disconnects, and then the connect times out
    connection.disconnect();
    await vi.advanceTimersByTimeAsync(30_000);

    // Then
    expect(frame.posted.map(envelope => envelope.method)).toEqual(['chainConnect', 'chainDisconnect']);
    expect(frame.posted.map(envelope => (envelope.payload as { connectionId: string }).connectionId)).toEqual([
      connectionId,
      connectionId,
    ]);
  });
});
