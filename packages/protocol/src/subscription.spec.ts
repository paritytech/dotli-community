// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { manualTimers, type ManualTimers } from '@dotli/shared/testing';
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
import { createFakeFrame } from './frame.fake.js';
import { protocolSchema, type FrameFailure, type ProtocolTransport, type RemoteFailure } from './schema.js';
import { subscribe } from './subscription.js';

const { frame, resolve } = protocolSchema.traits;

describe('subscribe', () => {
  let timers: ManualTimers;
  let statusSinks: Sink<void, FrameFailure>[];
  let resolveSinks: Sink<MethodTypes<typeof resolve.dotName>['receive'], RemoteFailure>[];
  let stops: number;

  const settle = (): Promise<void> => timers.advance(0);

  /** A frame app that keeps the sink of each status and name resolution it serves. */
  const serve = (serving: ProtocolTransport): void => {
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
  };

  /** The host's transport to a frame app that is up. */
  async function hostTransport(): Promise<ProtocolTransport> {
    const fake = createFakeFrame(serve, { timers });
    const transport = await fake.frame.transport();
    await settle();
    return transport;
  }

  beforeEach(() => {
    timers = manualTimers();
    statusSinks = [];
    resolveSinks = [];
    stops = 0;
  });

  it('As the host, I hear each value, then a clean end as null', async () => {
    // Given
    const transport = await hostTransport();
    const heard: string[] = [];
    const ends: (Error | null)[] = [];
    const status = subscribe(transport, frame.status, undefined, () => heard.push('ready'));
    status.onEnd(error => ends.push(error));
    await settle();

    // When
    statusSinks[0]?.receive(undefined);
    statusSinks[0]?.interrupt(ok());
    await settle();

    // Then
    expect(heard).toEqual(['ready']);
    expect(ends).toEqual([null]);
  });

  it("As the host, I hear the frame's typed failure as the error class my error screen knows", async () => {
    // Given
    const transport = await hostTransport();
    const ends: (Error | null)[] = [];
    subscribe(transport, frame.status, undefined, () => undefined).onEnd(error => ends.push(error));
    subscribe(transport, resolve.dotName, { label: 'doom' }, () => undefined).onEnd(error => ends.push(error));
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

  it('As the host, a subscription I give up on ends with my reason and stops in the frame', async () => {
    // Given
    const transport = await hostTransport();
    const giveUp = new AbortController();
    const ends: (Error | null)[] = [];
    subscribe(transport, resolve.dotName, { label: 'doom' }, () => undefined, {
      signal: giveUp.signal,
    }).onEnd(error => ends.push(error));
    await settle();
    const reason = new Error('budget spent');

    // When
    giveUp.abort(reason);
    await settle();

    // Then
    expect(ends).toEqual([reason]);
    expect(stops).toBe(1);
  });

  it('As the host, a subscription the transport closes under ends once with the closing error', async () => {
    // Given
    const transport = await hostTransport();
    const ends: (Error | null)[] = [];
    subscribe(transport, frame.status, undefined, () => undefined).onEnd(error => ends.push(error));
    await settle();
    const loss = new ProtocolFatalError('boom');

    // When
    transport.dispose(loss);
    await settle();

    // Then
    expect(ends).toEqual([loss]);
  });

  it('As the host, a subscription to a frame of a later release ends with the version mismatch my reload screen knows', async () => {
    // Given a frame that speaks a wire version the host cannot
    const { left, right } = createProviderPair();
    createTransport(defineSchema({ version: 255, hello: _void, traits: {} }), right, {
      handshake: 'accept',
      hello: undefined,
    });
    const transport = createTransport(protocolSchema, left, {
      handshake: 'open',
      hello: { resolutionId: null },
      timers,
    });
    const ends: (Error | null)[] = [];
    subscribe(transport, frame.status, undefined, () => undefined).onEnd(error => ends.push(error));

    // When
    transport.connect();
    await settle();

    // Then
    expect(ends).toEqual([expect.any(ProtocolVersionMismatchError)]);
  });

  it('As the host, an end listener that throws is reported and the next one still hears the end, also when it subscribes late', async () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const transport = await hostTransport();
    const status = subscribe(transport, frame.status, undefined, () => undefined);
    const ends: (Error | null)[] = [];
    status.onEnd(() => {
      throw new TypeError('listener broke');
    });
    status.onEnd(error => ends.push(error));
    await settle();

    // When
    statusSinks[0]?.interrupt(ok());
    await settle();
    status.onEnd(error => ends.push(error));

    // Then
    expect(ends).toEqual([null, null]);
    expect(captured).toEqual([{ flow: 'protocol', step: 'listener', tags: { owner: 'protocol.transport' } }]);
    expect(metrics.counted(S.LISTENER_DELIVERY)).toEqual([
      { outcome: 'error', reason: 'TypeError', owner: 'protocol.transport' },
    ]);
  });

  it('As the host, I unsubscribe and the frame stops it, and no end listener hears anything', async () => {
    // Given
    const transport = await hostTransport();
    const ends: (Error | null)[] = [];
    const status = subscribe(transport, frame.status, undefined, () => undefined);
    status.onEnd(error => ends.push(error));
    await settle();

    // When
    status.unsubscribe();
    status.onEnd(error => ends.push(error));
    statusSinks[0]?.interrupt(ok());
    await settle();

    // Then
    expect(stops).toBe(1);
    expect(ends).toEqual([]);
  });
});
