// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import { log } from '@dotli/shared';
import { m, spans as S } from '@dotli/metrics';
import {
  createRemoteChainProvider,
  getProtocolOrigin,
  isProtocolBooting,
  isProtocolReady,
  onProtocolReady,
  resetProtocolFrame,
  type RemoteChainHalt,
} from '../src/client.js';
import type { ProtocolEnvelope, ProtocolRequestEnvelope } from '../src/messages.js';

// The client's protocol iframe points at a host that does not exist here; keep
// happy-dom from fetching it (which logs ECONNREFUSED) but keep `contentWindow`.
(
  window as unknown as { happyDOM: { settings: { navigation: { disableChildFrameNavigation: boolean } } } }
).happyDOM.settings.navigation.disableChildFrameNavigation = true;

interface Frame {
  posted: ProtocolRequestEnvelope[];
  deliver: (envelope: ProtocolEnvelope) => void;
}

const flush = (): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, 0);
  });

/** Boots the client's protocol iframe and returns a way to talk as it. */
async function bootFrame(): Promise<Frame> {
  await flush();
  const iframe = document.querySelector('iframe');
  const frameWindow = iframe?.contentWindow;
  if (iframe === null || frameWindow === null || frameWindow === undefined) {
    throw new Error('missing protocol iframe');
  }
  const posted: ProtocolRequestEnvelope[] = [];
  vi.spyOn(frameWindow, 'postMessage').mockImplementation((message: unknown) => {
    posted.push(message as ProtocolRequestEnvelope);
  });
  const deliver = (envelope: ProtocolEnvelope): void => {
    window.dispatchEvent(
      new MessageEvent('message', { data: envelope, origin: getProtocolOrigin(), source: frameWindow }),
    );
  };
  iframe.dispatchEvent(new Event('load'));
  await flush();
  deliver({ namespace: 'dotli:protocol', kind: 'ready' });
  await flush();
  return { posted, deliver };
}

interface Remote {
  frame: Frame;
  received: JsonRpcMessage[];
  connection: JsonRpcConnection;
  connectionId: string;
}

/** Opens another connection against a frame that is already booted. */
async function connectMore(frame: Frame, onHalt?: (reason: RemoteChainHalt) => void): Promise<Remote> {
  const provider = createRemoteChainProvider(getActiveServicesConfig().people.genesis);
  if (provider === null) {
    throw new Error('People is not remote-connectable');
  }
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
  const provider = createRemoteChainProvider(getActiveServicesConfig().people.genesis);
  if (provider === null) {
    throw new Error('People is not remote-connectable');
  }
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
  afterEach(() => {
    resetProtocolFrame();
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
    const provider = createRemoteChainProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }
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

  it('As a dotli integrator, a halt listener that throws is logged and the connection still closes', async () => {
    // Given
    const logError = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const { frame, received, connection, connectionId } = await connectRemote(() => {
      throw new Error('listener bug');
    });

    // When
    frame.deliver({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId });
    connection.send({ jsonrpc: '2.0', id: 9, method: 'chainSpec_v1_genesisHash', params: [] });

    // Then
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('onHalt threw'), 'listener bug');
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

  it('As a dotli integrator, a dead protocol frame halts every open chain connection once', async () => {
    // Given
    const firstHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const secondHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
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
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const provider = createRemoteChainProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }
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
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const listener: Mock<() => void> = vi.fn<() => void>();

    // When
    const unsubscribe = onProtocolReady(listener);
    await flush();

    // Then
    expect(document.querySelector('iframe')).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    // When
    const first = await connectRemote();

    // Then
    expect(listener).toHaveBeenCalledTimes(1);

    // When
    first.frame.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await connectRemote();

    // Then
    expect(listener).toHaveBeenCalledTimes(2);

    // When
    unsubscribe();
    resetProtocolFrame();
    await connectRemote();

    // Then
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('As a dotli integrator, I can tell whether a protocol frame is up, without starting one', async () => {
    // Given
    vi.spyOn(log, 'error').mockImplementation(() => undefined);

    // Then
    expect(isProtocolReady()).toBe(false);
    expect(document.querySelector('iframe')).toBeNull();

    // When
    const first = await connectRemote();

    // Then
    expect(isProtocolReady()).toBe(true);

    // When
    first.frame.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });

    // Then
    expect(isProtocolReady()).toBe(false);

    // When
    await connectRemote();
    resetProtocolFrame();

    // Then
    expect(isProtocolReady()).toBe(false);
  });

  it('As a dotli integrator, I can tell whether a protocol frame is on its way up, without starting one', async () => {
    // Given
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const provider = createRemoteChainProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }

    // Then
    expect(isProtocolBooting()).toBe(false);
    expect(document.querySelector('iframe')).toBeNull();

    // When: a connection starts a frame, and another connects while it boots.
    provider(() => undefined);
    await flush();
    const booting = isProtocolBooting();
    provider(() => undefined);
    await flush();

    // Then: both wait on the one frame.
    expect(booting).toBe(true);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);

    // When
    const frame = await bootFrame();

    // Then
    expect(isProtocolBooting()).toBe(false);
    expect(frame.posted.filter(envelope => envelope.method === 'chainConnect')).toHaveLength(2);

    // When
    frame.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });

    // Then
    expect(isProtocolBooting()).toBe(false);
  });

  it('As a dotli integrator, a frame whose ready wait gave up is no longer on its way up', async () => {
    // Given: a connection starts a frame, which loads but never reports ready.
    vi.useFakeTimers();
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const provider = createRemoteChainProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    provider(() => undefined, onHalt);
    await vi.advanceTimersByTimeAsync(0);
    document.querySelector('iframe')?.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(0);
    const booting = isProtocolBooting();

    // When: its ready wait times out.
    await vi.advanceTimersByTimeAsync(240_000);

    // Then
    expect(booting).toBe(true);
    expect(onHalt).toHaveBeenCalledWith('frame');
    expect(isProtocolBooting()).toBe(false);
  });

  it('As a dotli integrator, a consumer that throws while its queued send is closed cannot stop the rest from halting', async () => {
    // Given
    const logError = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const provider = createRemoteChainProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }
    const throwing = provider(() => {
      throw new Error('consumer bug');
    });
    throwing.send({ jsonrpc: '2.0', id: 1, method: 'chainSpec_v1_genesisHash', params: [] });
    const frame = await bootFrame();
    const chainConnect = frame.posted.find(envelope => envelope.method === 'chainConnect');
    if (chainConnect === undefined) {
      throw new Error('no chainConnect posted');
    }
    const secondHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const second = createRemoteChainProvider(getActiveServicesConfig().people.genesis)?.(() => undefined, secondHalt);
    if (second === undefined) {
      throw new Error('People is not remote-connectable');
    }
    await flush();

    // When
    frame.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await flush();

    // Then
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('onMessage threw'), 'consumer bug');
    expect(secondHalt).toHaveBeenCalledTimes(1);
    expect(secondHalt).toHaveBeenCalledWith('frame');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('As a dotli integrator, a send the frame refuses after its chain halted is neither logged nor answered', async () => {
    // Given: a re-follow sent while the halt was on its way
    const logError = vi.spyOn(log, 'error').mockImplementation(() => undefined);
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
    expect(logError).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, a send still unacknowledged when the frame dies is neither logged nor answered', async () => {
    // Given
    const logError = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const { frame, received, connection } = await connectRemote(onHalt);
    connection.send({ jsonrpc: '2.0', id: 3, method: 'chainSpec_v1_genesisHash', params: [] });
    await flush();

    // When
    frame.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await flush();

    // Then
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledWith('frame');
    expect(received).toEqual([]);
    expect(logError).not.toHaveBeenCalledWith('[dot.li protocol] Remote chain send failed:', expect.anything());
  });

  it("As a dotli integrator, a chain connection's sends are not timed as protocol requests, while its connect is", async () => {
    // Given
    const timer = vi.spyOn(m, 'timer');
    const { connection } = await connectRemote();
    const timedRequests = (): number => timer.mock.calls.filter(([span]) => span === S.PROTOCOL_REQUEST).length;
    const afterConnect = timedRequests();

    // When
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainSpec_v1_genesisHash', params: [] });
    connection.send({ jsonrpc: '2.0', id: 2, method: 'chainSpec_v1_genesisHash', params: [] });
    await flush();

    // Then
    expect(afterConnect).toBe(1);
    expect(timedRequests()).toBe(1);
  });

  it('As a dotli integrator, a connection closed while its frame boots never reaches the frame', async () => {
    // Given: a connection with a send queued, closed before its frame is up.
    const provider = createRemoteChainProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }
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
    const provider = createRemoteChainProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }
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
    const logError = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const provider = createRemoteChainProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }
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
    expect(logError).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, a connection the frame refuses to open halts as a dead frame', async () => {
    // Given: a send queued before the frame answers the connect
    const logError = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    const provider = createRemoteChainProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }
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
    expect(logError).toHaveBeenCalledWith('[dot.li protocol] Failed to connect remote chain:', expect.any(Error));
  });
});
