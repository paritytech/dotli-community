// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { createManualTimers, type ManualTimers } from '@dotli/shared/testing';
import { _void } from 'scale-ts';
import {
  createTransport,
  defineSchema,
  domain,
  err,
  hostFailure,
  ok,
  type MethodTypes,
  type Sink,
} from '@dotli/transport';
import { createProviderPair } from '@dotli/transport/testing';
import { ProtocolFatalError, ProtocolVersionMismatchError } from './errors.js';
import { createFakeFrame } from './createProtocolFrame.fake.js';
import type { FrameStatusSink } from './createFrameStatus.js';
import { protocolSchema, type ProtocolTransport, type RemoteFailure, type SubscriptionEnd } from './schema.js';
import { subscribe } from './subscribe.js';

const { frame, resolve } = protocolSchema.sections;

describe('subscribe', () => {
  let timers: ManualTimers;
  let statusSinks: FrameStatusSink[];
  let resolveSinks: Sink<MethodTypes<typeof resolve.dotName>['receive'], SubscriptionEnd<RemoteFailure>>[];
  let stops: number;

  function settle(): Promise<void> {
    return timers.advance(0);
  }

  /** A frame app that keeps the sink of each status and name resolution it serves. */
  function serve(serving: ProtocolTransport): void {
    serving.handleSubscription(frame.status, (_start, _context, sink) => {
      statusSinks.push(sink);
      return () => {
        stops += 1;
      };
    });
    serving.handleSubscription(resolve.dotName, (_start, _context, sink) => {
      resolveSinks.push(sink);
      return () => {
        stops += 1;
      };
    });
  }

  /** The host's transport to a frame app that is up. */
  async function openHostTransport(): Promise<ProtocolTransport> {
    const fake = createFakeFrame({ serve, timers });
    const transport = await fake.frame.getTransport();
    await settle();
    return transport;
  }

  beforeEach(() => {
    timers = createManualTimers();
    statusSinks = [];
    resolveSinks = [];
    stops = 0;
  });

  it('As the host, I hear each value, then a clean end as null', async () => {
    // Given
    const transport = await openHostTransport();
    const heard: string[] = [];
    const ends: (Error | null)[] = [];
    subscribe({
      transport,
      method: frame.status,
      start: undefined,
      listeners: {
        receive: () => heard.push('ready'),
        end: error => ends.push(error),
      },
    });
    await settle();

    // When
    statusSinks[0]?.send(undefined);
    statusSinks[0]?.interrupt(ok());
    await settle();

    // Then
    expect(heard).toEqual(['ready']);
    expect(ends).toEqual([null]);
  });

  it("As the host, I hear the frame's typed failure as the error class my error screen knows", async () => {
    // Given
    const transport = await openHostTransport();
    const ends: (Error | null)[] = [];
    const listeners = { receive: () => undefined, end: (error: Error | null) => ends.push(error) };
    subscribe({ transport, method: frame.status, start: undefined, listeners });
    subscribe({ transport, method: resolve.dotName, start: { label: 'doom' }, listeners });
    await settle();

    // When
    statusSinks[0]?.interrupt(err(domain({ tag: 'fatal', value: 'wasm trap' })));
    resolveSinks[0]?.interrupt(err(hostFailure('DotNsError: no owner')));
    await settle();

    // Then
    expect(ends[0]).toBeInstanceOf(ProtocolFatalError);
    expect(ends[0]?.message).toBe('wasm trap');
    expect(ends[1]).toMatchObject({ name: 'DotNsError', message: 'no owner', method: 'resolveDotName' });
  });

  it('As the host, I hear a subscription the frame fails on its own end with the error a failed call ends with', async () => {
    // Given a frame that serves no chain connections
    const transport = await openHostTransport();
    const ends: (Error | null)[] = [];

    // When
    subscribe({
      transport,
      method: protocolSchema.sections.chain.connect,
      start: { genesisHash: '0x91b171bb', connectionId: 'c1' },
      listeners: { receive: () => undefined, end: error => ends.push(error) },
    });
    await settle();

    // Then
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      name: 'Unsupported',
      message: 'The frame does not serve "chainConnect"',
      method: 'chainConnect',
    });
  });

  it('As the host, I give up on a subscription and it ends with my reason and stops in the frame', async () => {
    // Given
    const transport = await openHostTransport();
    const giveUp = new AbortController();
    const ends: (Error | null)[] = [];
    subscribe({
      transport,
      method: resolve.dotName,
      start: { label: 'doom' },
      listeners: { receive: () => undefined, end: error => ends.push(error) },
      signal: giveUp.signal,
    });
    await settle();
    const reason = new Error('budget spent');

    // When
    giveUp.abort(reason);
    await settle();

    // Then
    expect(ends).toEqual([reason]);
    expect(stops).toBe(1);
  });

  it('As the host, I hear a subscription the transport closes under end once with the closing error', async () => {
    // Given
    const transport = await openHostTransport();
    const ends: (Error | null)[] = [];
    subscribe({
      transport,
      method: frame.status,
      start: undefined,
      listeners: { receive: () => undefined, end: error => ends.push(error) },
    });
    await settle();
    const loss = new ProtocolFatalError('boom');

    // When
    transport.dispose(loss);
    await settle();

    // Then
    expect(ends).toEqual([loss]);
  });

  it('As the host, I subscribe to a frame of a later release and hear it end with the version mismatch my reload screen knows', async () => {
    // Given a frame that speaks a wire version the host cannot
    const { left, right } = createProviderPair();
    createTransport({
      schema: defineSchema({ version: 255, hello: _void, sections: {} }),
      provider: right,
      handshake: 'respond',
      hello: undefined,
    });
    const transport = createTransport({
      schema: protocolSchema,
      provider: left,
      handshake: 'offer',
      hello: { resolutionId: null },
      timers,
    });
    const ends: (Error | null)[] = [];
    subscribe({
      transport,
      method: frame.status,
      start: undefined,
      listeners: { receive: () => undefined, end: error => ends.push(error) },
    });

    // When
    transport.connect();
    await settle();

    // Then
    expect(ends).toEqual([expect.any(ProtocolVersionMismatchError)]);
  });

  it('As the host, I unsubscribe and the frame stops it, and no end listener hears anything', async () => {
    // Given
    const transport = await openHostTransport();
    const ends: (Error | null)[] = [];
    const unsubscribe = subscribe({
      transport,
      method: frame.status,
      start: undefined,
      listeners: {
        receive: () => undefined,
        end: error => ends.push(error),
      },
    });
    await settle();

    // When
    unsubscribe();
    statusSinks[0]?.interrupt(ok());
    await settle();

    // Then
    expect(stops).toBe(1);
    expect(ends).toEqual([]);
  });
});
