// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink, spans as S, type CaptureContext } from '@dotli/metrics';
import { bindLogSink } from '@dotli/shared';
import { deferred, manualTimers } from '@dotli/shared/testing';
import { ProtocolPortReleasedError, ProtocolRequestError } from './errors.js';
import { WIRE_VERSION } from './methods.js';
import { createProviderPair } from './provider.fake.js';
import type { Provider } from './provider.js';
import { decodedLegs, outcomeOf, rawPeer, rig } from './testing/transport-rig.js';
import { createConsumerTransport } from './transport-consumer.js';
import { createServingTransport, type SubscriptionSink } from './transport-serving.js';

/** A serving transport facing a raw peer, over a provider whose posts throw once the test breaks it. */
function brokenPostRig() {
  const { left, right } = createProviderPair();
  const timers = manualTimers();
  const count = vi.fn();
  const broken = new Error('the peer window is gone');
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
  const serving = createServingTransport(provider, { side: 'frame', count });
  const reports = { captured: [] as { error: unknown; context: CaptureContext }[], errors: [] as string[] };
  onTestFinished(
    bindCaptureSink({
      exception: (error, context) => reports.captured.push({ error, context }),
      expected: () => undefined,
    }),
  );
  onTestFinished(
    bindLogSink({
      emit: (level, _message, _attrs, args = []) => {
        if (level === 'error') {
          reports.errors.push(String(args[0]));
        }
      },
    }),
  );
  return {
    serving,
    peer: rawPeer(left),
    timers,
    count,
    reports,
    broken,
    breakPosts: () => {
      posting = false;
    },
  };
}

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

  it('As the worker, I hear that a disposed tab left once its last unsubscribe and its last call are done', async () => {
    // Given a tab with two subscriptions and a call the worker still holds
    const { left, right } = createProviderPair();
    const timers = manualTimers();
    const onPeerIdle = vi.fn();
    const serving = createServingTransport(right, { side: 'worker', count: vi.fn(), onPeerIdle });
    const consumer = createConsumerTransport(left, { side: 'frame', timers, count: vi.fn() });
    serving.handleSubscription('frameStatus', () => () => undefined);
    serving.handleSubscription('beat', () => () => undefined);
    const held = deferred<null>();
    serving.handleRequest('resolveOwner', () => held.promise);
    consumer.connect();
    consumer.subscribe('frameStatus', undefined, () => undefined);
    consumer.subscribe('beat', undefined, () => undefined);
    void consumer.request('resolveOwner', { label: 'doom' }).catch(() => undefined);
    await timers.advance(0);

    // When the tab disposes its transport
    consumer.dispose(new Error('pagehide'));
    await timers.advance(0);

    // Then the call in flight holds the port
    expect(onPeerIdle).not.toHaveBeenCalled();

    // When the call settles
    held.resolve(null);
    await timers.advance(0);

    // Then the tab is gone, once
    expect(onPeerIdle).toHaveBeenCalledOnce();
  });

  it('As the worker, I do not take a tab for gone when I ended its subscriptions myself', async () => {
    // Given a tab with two subscriptions
    const { left, right } = createProviderPair();
    const timers = manualTimers();
    const onPeerIdle = vi.fn();
    const serving = createServingTransport(right, { side: 'worker', count: vi.fn(), onPeerIdle });
    const consumer = createConsumerTransport(left, { side: 'frame', timers, count: vi.fn() });
    const sinks: SubscriptionSink<'beat'>[] = [];
    serving.handleSubscription('beat', (_payload, _context, sink) => {
      sinks.push(sink);
      return () => undefined;
    });
    consumer.connect();
    const ends = vi.fn();
    consumer.subscribe('beat', undefined, () => undefined).onEnd(ends);
    consumer.subscribe('beat', undefined, () => undefined).onEnd(ends);
    await timers.advance(0);

    // When this end ends both
    for (const sink of sinks) {
      sink.end();
    }
    await timers.advance(0);

    // Then the tab heard both ends and is not taken for gone
    expect(ends).toHaveBeenCalledTimes(2);
    expect(onPeerIdle).not.toHaveBeenCalled();

    // When it subscribes again and leaves that one
    const again = consumer.subscribe('beat', undefined, () => undefined);
    await timers.advance(0);
    again.unsubscribe();
    await timers.advance(0);

    // Then it is
    expect(onPeerIdle).toHaveBeenCalledOnce();
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
    const { serving, peer, timers, count, reports, breakPosts, broken } = brokenPostRig();
    const answer = deferred<undefined>();
    serving.handleRequest('heartbeat', () => answer.promise);
    peer.send({ leg: 'request', id: 1, method: 'heartbeat', deadlineMs: null, payload: undefined });
    await timers.advance(0);

    // When
    breakPosts();
    answer.resolve(undefined);
    await timers.advance(0);

    // Then
    expect(reports.captured).toEqual([
      {
        error: broken,
        context: { flow: 'protocol', step: 'serve_post', tags: { method: 'heartbeat', side: 'frame' } },
      },
    ]);
    expect(reports.errors).toEqual(['[dot.li] A heartbeat message could not be posted']);
    expect(count).toHaveBeenCalledExactlyOnceWith(S.PROTOCOL_SERVE_POST, {
      outcome: 'error',
      reason: 'Error',
      side: 'frame',
    });
  });

  it('As a handler, an event or end my provider cannot post is reported and never thrown into my call', async () => {
    // Given
    const { serving, peer, timers, count, reports, breakPosts, broken } = brokenPostRig();
    let sink: SubscriptionSink<'sharedAuthChanges'> | undefined;
    serving.handleSubscription('sharedAuthChanges', (_payload, _context, given) => {
      sink = given;
      return () => undefined;
    });
    peer.send({ leg: 'subscribe', id: 1, method: 'sharedAuthChanges', deadlineMs: null, payload: undefined });
    await timers.advance(0);
    breakPosts();

    // When
    const send = (): void => {
      sink?.send({ siteId: 's', key: 'k', value: null });
    };
    const end = (): void => {
      sink?.end();
    };

    // Then
    expect(send).not.toThrow();
    expect(end).not.toThrow();
    const reported = {
      error: broken,
      context: { flow: 'protocol', step: 'serve_post', tags: { method: 'sharedAuthChanges', side: 'frame' } },
    };
    expect(reports.captured).toEqual([reported, reported]);
    expect(reports.errors).toHaveLength(2);
    expect(count.mock.calls).toEqual([
      [S.PROTOCOL_SERVE_POST, { outcome: 'error', reason: 'Error', side: 'frame' }],
      [S.PROTOCOL_SERVE_POST, { outcome: 'error', reason: 'Error', side: 'frame' }],
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
  it('As a handler, my send and end after the subscription stopped do nothing', async () => {
    // Given
    const { consumer, serving, timers, delivered } = rig();
    let sink: SubscriptionSink<'sharedAuthChanges'> | undefined;
    const stop = vi.fn();
    serving.handleSubscription('sharedAuthChanges', (_payload, _context, given) => {
      sink = given;
      return stop;
    });
    consumer.connect();
    consumer.subscribe('sharedAuthChanges', undefined, () => undefined).unsubscribe();
    const subscription = consumer.subscribe('sharedAuthChanges', undefined, () => undefined);
    await timers.advance(0);
    subscription.unsubscribe();
    await timers.advance(0);
    expect(stop).toHaveBeenCalledOnce();
    const posted = delivered.length;

    // When
    sink?.send({ siteId: 's', key: 'k', value: null });
    sink?.end();
    sink?.end(new Error('again'));
    await timers.advance(0);

    // Then
    expect(delivered).toHaveLength(posted);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('As a handler, an answer that cannot be encoded answers the call with the encode error', async () => {
    // Given
    const { consumer, serving, timers } = rig();
    serving.handleRequest('resolveExecutableManifest', () => ({ kind: 'nope' }) as never);
    consumer.connect();

    // When
    const call = outcomeOf(consumer.request('resolveExecutableManifest', { label: 'a', kind: 'app' }));
    await timers.advance(0);

    // Then
    const error = await call;
    expect(error).toBeInstanceOf(ProtocolRequestError);
    expect(error).toMatchObject({ name: 'TypeError', method: 'resolveExecutableManifest' });
  });
});
