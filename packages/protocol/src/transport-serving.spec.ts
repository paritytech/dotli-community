// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindLogSink } from '@dotli/shared';
import { deferred, manualTimers } from '@dotli/shared/testing';
import { ProtocolPortReleasedError } from './errors.js';
import { WIRE_VERSION } from './methods.js';
import { createProviderPair } from './provider.fake.js';
import type { Provider } from './provider.js';
import { decodedLegs, outcomeOf, rawPeer, rig } from './testing/transport-rig.js';
import { createConsumerTransport } from './transport-consumer.js';
import { createServingTransport } from './transport-serving.js';
import { ProtocolRequestError } from './errors.js';

describe('createServingTransport', () => {
  it('As the frame, I refuse a handshake of another wire version', async () => {
    // Given
    const { left, right } = createProviderPair();
    const timers = manualTimers();
    createServingTransport(right, { side: 'frame', count: vi.fn() });
    const peer = rawPeer(left);

    // When
    peer.send({
      leg: 'request',
      id: 1,
      method: 'handshake',
      deadlineMs: null,
      payload: { version: WIRE_VERSION + 1, resolutionId: null },
    });
    await timers.advance(0);

    // Then
    expect(peer.heard).toHaveLength(1);
    expect(peer.heard[0]).toMatchObject({
      leg: 'response',
      id: 1,
      method: 'handshake',
      outcome: { ok: false, error: { name: 'ProtocolVersionMismatchError' } },
    });
  });

  it("As a handler, I read the caller's deadline, origin and resolution id", async () => {
    // Given
    const { consumer, serving, timers } = rig({ resolutionId: 'r1' });
    const handler = vi.fn(() => undefined);
    serving.handleRequest('heartbeat', handler);
    consumer.connect();

    // When
    const call = consumer.request('heartbeat', undefined, { deadlineMs: 1_234 });
    await timers.advance(0);
    await call;

    // Then
    expect(handler).toHaveBeenCalledExactlyOnceWith(undefined, {
      origin: null,
      deadlineMs: 1_234,
      resolutionId: 'r1',
    });
  });

  it('As the worker, disposing my serving transport ends each open subscription with the reason', async () => {
    // Given
    const { left, right, delivered } = createProviderPair();
    const timers = manualTimers();
    const serving = createServingTransport(right, { side: 'worker', count: vi.fn() });
    const consumer = createConsumerTransport(left, { side: 'frame', timers, count: vi.fn() });
    const stops = [vi.fn(), vi.fn()];
    let started = 0;
    serving.handleSubscription('chainConnect', () => {
      const stop = stops[started];
      started += 1;
      return stop ?? (() => undefined);
    });
    consumer.connect();
    const ends = [vi.fn(), vi.fn()];
    for (const [index, onEnd] of ends.entries()) {
      consumer
        .subscribe('chainConnect', { genesisHash: '0x1', connectionId: `c${String(index)}` }, () => undefined)
        .onEnd(onEnd);
    }
    await timers.advance(0);

    // When
    serving.dispose(new ProtocolPortReleasedError('the worker let this tab go'));
    await timers.advance(0);

    // Then
    for (const stop of stops) {
      expect(stop).toHaveBeenCalledOnce();
    }
    for (const onEnd of ends) {
      expect(onEnd).toHaveBeenCalledOnce();
      expect(onEnd.mock.calls[0]?.[0]).toMatchObject({ name: 'ProtocolPortReleasedError' });
    }
    expect(decodedLegs(delivered).filter(leg => leg === 'end:chainConnect')).toHaveLength(2);
  });

  it('As the frame, I refuse a second handler for one method', () => {
    // Given
    const { serving } = rig();
    serving.handleRequest('heartbeat', () => undefined);
    serving.handleSubscription('telemetry', () => () => undefined);

    // When / Then
    expect(() => serving.handleRequest('heartbeat', () => undefined)).toThrow('heartbeat already has a handler');
    expect(() => serving.handleSubscription('telemetry', () => () => undefined)).toThrow(
      'telemetry already has a handler',
    );
  });

  it('As the frame, I unregister a handler and a call then answers that I do not handle it', async () => {
    // Given
    const { consumer, serving, timers } = rig();
    const first = vi.fn(() => undefined);
    const unregisterFirst = serving.handleRequest('heartbeat', first);
    unregisterFirst();
    const second = vi.fn(() => undefined);
    const unregisterSecond = serving.handleRequest('heartbeat', second);
    consumer.connect();

    // When
    unregisterFirst();
    const answered = outcomeOf(consumer.request('heartbeat', undefined));
    await timers.advance(0);

    // Then
    expect(await answered).toEqual({ value: undefined });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    // When
    unregisterSecond();
    const refused = outcomeOf(consumer.request('heartbeat', undefined));
    await timers.advance(0);

    // Then
    expect(await refused).toBeInstanceOf(ProtocolRequestError);
    expect(await refused).toMatchObject({ message: 'This end does not handle heartbeat' });
  });

  it('As a handler, my answer after the serving end is disposed is logged and never posted', async () => {
    // Given
    const { consumer, serving, timers, delivered } = rig();
    const answer = deferred<string | null>();
    serving.handleRequest('resolveOwner', () => answer.promise);
    consumer.connect();
    void outcomeOf(consumer.request('resolveOwner', { label: 'a' }));
    await timers.advance(0);
    const events: { message: string; attrs: Record<string, unknown> | undefined }[] = [];
    const unbind = bindLogSink({
      emit: (level, message, attrs) => {
        if (level === 'info') {
          events.push({ message, attrs });
        }
      },
    });

    // When
    serving.dispose(new Error('frame closing'));
    answer.resolve('5Grw');
    await timers.advance(0);
    unbind();

    // Then
    expect(decodedLegs(delivered).filter(leg => leg.startsWith('response:resolveOwner'))).toEqual([]);
    expect(events).toEqual([
      {
        message: 'protocol answer after dispose',
        attrs: { flow: 'protocol', method: 'resolveOwner', side: 'frame', outcome: 'ok' },
      },
    ]);
  });

  it('As the frame, an answer my provider cannot post is reported and never left unhandled', async () => {
    // Given
    const { left, right } = createProviderPair();
    const timers = manualTimers();
    const broken = new Error('the peer window is gone');
    const answer = deferred<undefined>();
    let posting = true;
    const provider: Provider = {
      ...right,
      post: data => {
        if (!posting) {
          throw broken;
        }
        right.post(data);
      },
    };
    const serving = createServingTransport(provider, { side: 'frame', count: vi.fn() });
    serving.handleRequest('heartbeat', () => answer.promise);
    const peer = rawPeer(left);
    const captured: { error: unknown; context: CaptureContext }[] = [];
    const unbind = bindCaptureSink({
      exception: (error, context) => captured.push({ error, context }),
      expected: () => undefined,
    });
    peer.send({ leg: 'request', id: 1, method: 'heartbeat', deadlineMs: null, payload: undefined });
    await timers.advance(0);

    // When
    posting = false;
    answer.resolve(undefined);
    await timers.advance(0);
    unbind();

    // Then
    expect(captured).toEqual([
      {
        error: broken,
        context: { flow: 'protocol', step: 'answer_post', tags: { method: 'heartbeat', side: 'frame' } },
      },
    ]);
  });

  it('As the frame, a stop function that throws is reported and the others still run', async () => {
    // Given
    const { consumer, serving, timers, report } = rig();
    const bug = new Error('stop bug');
    const stops = [
      vi.fn(() => {
        throw bug;
      }),
      vi.fn(),
    ];
    let started = 0;
    serving.handleSubscription('telemetry', () => {
      const stop = stops[started] ?? (() => undefined);
      started += 1;
      return stop;
    });
    consumer.connect();
    consumer.subscribe('telemetry', undefined, () => undefined);
    consumer.subscribe('telemetry', undefined, () => undefined);
    await timers.advance(0);

    // When
    serving.dispose(new Error('frame closing'));

    // Then
    expect(stops[1]).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledExactlyOnceWith(bug);
  });
});
