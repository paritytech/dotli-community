// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import { log } from '@dotli/shared';
import { createRemoteChainProvider, getProtocolOrigin, resetProtocolFrame } from '../src/client.js';
import type { ProtocolEnvelope, ProtocolRequestEnvelope } from '../src/messages.js';

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

async function connectRemote(onHalt?: () => void): Promise<{
  frame: Frame;
  received: JsonRpcMessage[];
  connection: JsonRpcConnection;
  connectionId: string;
}> {
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
  });

  it('As a dotli integrator, a chain-halt tells the connection once and closes it', async () => {
    // Given
    const onHalt: Mock<() => void> = vi.fn<() => void>();
    const { frame, received, connection, connectionId } = await connectRemote(onHalt);

    // When
    frame.deliver({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId });
    frame.deliver({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId });
    connection.send({ jsonrpc: '2.0', id: 7, method: 'chainSpec_v1_genesisHash', params: [] });

    // Then
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(received).toEqual([
      { jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'Chain connection is closed' } },
    ]);
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

  it('As a dotli integrator, a connection closed before its chain halts hears nothing', async () => {
    // Given
    const onHalt: Mock<() => void> = vi.fn<() => void>();
    const { frame, connection, connectionId } = await connectRemote(onHalt);
    connection.disconnect();

    // When
    frame.deliver({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId });

    // Then
    expect(onHalt).not.toHaveBeenCalled();
  });
});
