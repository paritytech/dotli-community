// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { spans as S } from '@dotli/metrics';
import { bindLogSink } from '@dotli/shared';
import { manualTimers } from '@dotli/shared/testing';
import { ProtocolHandshakeTimeoutError, ProtocolRequestError, ProtocolVersionMismatchError } from './errors.js';
import type { SubscriptionEvent } from './methods.js';
import { createProviderPair } from './provider.fake.js';
import type { Provider } from './provider.js';
import { RETRY_MS, TIMEOUT_MS, outcomeOf, rawRig, rig } from './testing/transport-rig.js';
import { createConsumerTransport } from './transport-consumer.js';
import type { SubscriptionSink } from './transport-serving.js';
import type { WireMessage } from './wire-message.js';

describe('createConsumerTransport', () => {
  it('As a caller, my calls made before the handshake go out in call order', async () => {
    // Given
    const { consumer, serving, timers } = rig();
    const seen: string[] = [];
    serving.handleRequest('authStorageRead', ({ key }) => {
      seen.push(key);
      return null;
    });
    const read = (key: string) => consumer.request('authStorageRead', { siteId: 's', key });
    const fourth = read('1').then(() => read('4'));
    const second = read('2');
    const third = read('3');

    // When
    consumer.connect();
    await timers.advance(0);
    await Promise.all([fourth, second, third]);

    // Then
    expect(seen).toEqual(['1', '2', '3', '4']);
  });

  it('As a caller, a call I make from a listener while my queue flushes goes after the queued calls', async () => {
    // Given
    const { consumer, serving, timers } = rig();
    const seen: string[] = [];
    serving.handleRequest('authStorageRead', ({ key }) => {
      seen.push(key);
      return null;
    });
    const read = (key: string) => consumer.request('authStorageRead', { siteId: 's', key });
    const calls = [read('1')];
    // A deadline the wire cannot carry ends this subscription as the queue flushes.
    consumer
      .subscribe('frameStatus', undefined, () => undefined, { deadlineMs: 0.5 })
      .onEnd(() => {
        calls.push(read('3'));
      });
    calls.push(read('2'));

    // When
    consumer.connect();
    await timers.advance(0);
    await Promise.all(calls);

    // Then
    expect(seen).toEqual(['1', '2', '3']);
  });

  it('As a caller, my calls and subscriptions go out in call order across the handshake', async () => {
    // Given
    const { consumer, timers, peer, answerHandshake } = rawRig();
    // Registered first, so it hears the handshake end before any queued call does.
    const connected = consumer.whenConnected().then(() => {
      consumer.subscribe('frameStatus', undefined, () => undefined);
      void consumer.request('resolveOwner', { label: 'a' });
    });
    void consumer.request('heartbeat', undefined);
    consumer.subscribe('telemetry', undefined, () => undefined);
    consumer.connect();
    await timers.advance(0);
    void consumer.request('warmup', undefined);

    // When
    answerHandshake();
    consumer.subscribe('sharedAuthChanges', undefined, () => undefined);
    await connected;
    await timers.advance(0);

    // Then
    expect(peer.legs()).toEqual([
      'request:handshake',
      'request:heartbeat',
      'subscribe:telemetry',
      'request:warmup',
      'subscribe:sharedAuthChanges',
      'subscribe:frameStatus',
      'request:resolveOwner',
    ]);
  });

  it("As a caller, my call answers with the frame's typed answer", async () => {
    // Given
    const { consumer, serving, timers } = rig();
    const answer = {
      tag: 'ok' as const,
      value: {
        entropy: new Uint8Array([1, 2, 3]),
        identity: { identityAccountId: '5Grw', liteUsername: 'alice' },
      },
    };
    serving.handleRequest('localWalletRead', () => answer);
    consumer.connect();
    const { signal } = new AbortController();
    const detach = vi.spyOn(signal, 'removeEventListener');

    // When
    const call = consumer.request('localWalletRead', { siteId: 's' }, { signal });
    await timers.advance(0);

    // Then
    await expect(call).resolves.toEqual(answer);
    expect(detach).toHaveBeenCalledOnce();
  });

  it("As a caller, my call rejects with the frame's error, its name and stack kept", async () => {
    // Given
    const { consumer, serving, timers } = rig();
    const thrown = new TypeError('bad key');
    serving.handleRequest('authStorageRead', () => {
      throw thrown;
    });
    consumer.connect();

    // When
    const call = outcomeOf(consumer.request('authStorageRead', { siteId: 's', key: 'k' }));
    await timers.advance(0);

    // Then
    const error = await call;
    expect(error).toBeInstanceOf(ProtocolRequestError);
    expect(error).toMatchObject({
      name: 'TypeError',
      method: 'authStorageRead',
      remoteStack: thrown.stack?.slice(0, 2000),
    });
    expect((error as Error).message).toContain('bad key');
  });

  it('As a caller, my queued calls reject with the dispose reason and the handshake stops', async () => {
    // Given
    const { consumer, timers, peer, left } = rawRig();
    consumer.connect();
    const call = outcomeOf(consumer.request('authStorageRead', { siteId: 's', key: 'k' }));
    const onEnd = vi.fn();
    consumer.subscribe('sharedAuthChanges', undefined, () => undefined).onEnd(onEnd);
    await timers.advance(RETRY_MS * 2);
    expect(peer.legs()).toEqual(['request:handshake', 'request:handshake', 'request:handshake']);
    const post = vi.spyOn(left, 'post');
    const reason = new Error('frame lost');

    // When
    consumer.dispose(reason);
    await timers.advance(RETRY_MS * 10);

    // Then
    await expect(call).resolves.toBe(reason);
    await expect(consumer.whenConnected()).rejects.toBe(reason);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(reason);
    expect(post).not.toHaveBeenCalled();
    await expect(consumer.request('heartbeat', undefined)).rejects.toBe(reason);
  });

  it('As a caller, a frame of another wire version fails my handshake at once', async () => {
    // Given
    const { consumer, timers, peer } = rawRig();
    consumer.connect();
    const call = outcomeOf(consumer.request('heartbeat', undefined));
    const onEnd = vi.fn();
    consumer.subscribe('telemetry', undefined, () => undefined).onEnd(onEnd);
    await timers.advance(0);
    const [hello] = peer.heard;
    if (hello === undefined) {
      throw new Error('no handshake heard');
    }

    // When
    peer.send({
      leg: 'response',
      id: hello.id,
      method: 'handshake',
      outcome: { ok: false, error: { message: 'version 2', name: 'ProtocolVersionMismatchError', stack: null } },
    });
    await timers.advance(0);

    // Then
    await expect(consumer.whenConnected()).rejects.toBeInstanceOf(ProtocolVersionMismatchError);
    expect(await call).toBeInstanceOf(ProtocolVersionMismatchError);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd.mock.calls[0]?.[0]).toBeInstanceOf(ProtocolVersionMismatchError);
    expect(peer.legs()).not.toContain('subscribe:telemetry');
    const heard = peer.heard.length;
    await timers.advance(RETRY_MS * 10);
    expect(peer.heard).toHaveLength(heard);
  });

  it('As a caller, my handshake times out only on the running clock and survives a garbage answer', async () => {
    // Given
    const { consumer, timers, peer, right, count } = rawRig();
    consumer.connect();
    let settled: unknown;
    void outcomeOf(consumer.whenConnected()).then(outcome => {
      settled = outcome;
    });

    // When
    right.post(new Uint8Array([0xff, 0xff, 0xff]).buffer);
    await timers.advance(0);

    // Then
    expect(count).toHaveBeenCalledExactlyOnceWith(S.PROTOCOL_WIRE_REFUSED, {
      outcome: 'refused',
      reason: 'malformed',
      side: 'host',
    });
    const heard = peer.heard.length;
    await timers.advance(RETRY_MS);
    expect(peer.heard.length).toBeGreaterThan(heard);

    // When
    timers.freeze(TIMEOUT_MS * 4);
    await timers.advance(TIMEOUT_MS - RETRY_MS);

    // Then
    expect(settled).toBeUndefined();

    // When
    await timers.advance(TIMEOUT_MS);

    // Then
    expect(settled).toBeInstanceOf(ProtocolHandshakeTimeoutError);
  });

  it('As a receiver, I log each refused message once with what failed', async () => {
    // Given
    const { consumer, timers, right } = rawRig();
    const events: { message: string; attrs: Record<string, unknown> | undefined }[] = [];
    const unbind = bindLogSink({
      emit: (level, message, attrs) => {
        if (level === 'info') {
          events.push({ message, attrs });
        }
      },
    });
    consumer.connect();

    // When
    right.post(new Uint8Array([0xff, 0xff, 0xff]).buffer);
    await timers.advance(0);
    unbind();

    // Then
    expect(events).toEqual([
      {
        message: 'protocol message refused',
        attrs: {
          flow: 'protocol',
          reason: 'malformed',
          side: 'host',
          cause: 'RangeError: Offset is outside the bounds of the DataView',
        },
      },
    ]);
  });

  it('As a caller, a handshake answer after my handshake timed out changes nothing', async () => {
    // Given
    const { consumer, timers, peer, answerHandshake } = rawRig();
    const call = outcomeOf(consumer.request('heartbeat', undefined));
    consumer.connect();
    await timers.advance(TIMEOUT_MS);
    const timedOut = await outcomeOf(consumer.whenConnected());
    expect(timedOut).toBeInstanceOf(ProtocolHandshakeTimeoutError);
    const heard = peer.heard.length;

    // When
    answerHandshake();
    await timers.advance(RETRY_MS * 10);

    // Then
    expect(await outcomeOf(consumer.whenConnected())).toBe(timedOut);
    expect(await call).toBe(timedOut);
    expect(await outcomeOf(consumer.request('heartbeat', undefined))).toBe(timedOut);
    expect(peer.heard).toHaveLength(heard);
  });

  it('As a caller, my call gives up with the abort reason itself, and a reason that is no error is wrapped', async () => {
    // Given
    const { consumer, timers, answerHandshake } = rawRig();
    consumer.connect();
    await timers.advance(0);
    answerHandshake();
    await consumer.whenConnected();
    const withDefault = new AbortController();
    const withText = new AbortController();
    const defaultCall = outcomeOf(consumer.request('heartbeat', undefined, { signal: withDefault.signal }));
    const textCall = outcomeOf(consumer.request('heartbeat', undefined, { signal: withText.signal }));

    // When
    withDefault.abort();
    withText.abort('left the page');

    // Then
    expect(await defaultCall).toBe(withDefault.signal.reason);
    expect(await defaultCall).toBeInstanceOf(DOMException);
    expect(await textCall).toBeInstanceOf(Error);
    expect(await textCall).toMatchObject({ cause: 'left the page' });
  });

  it('As a caller, a late answer to a call I gave up on is ignored', async () => {
    // Given
    const { consumer, timers, peer, count, answerHandshake } = rawRig();
    consumer.connect();
    await timers.advance(0);
    answerHandshake();
    await consumer.whenConnected();
    const giveUp = new AbortController();
    const detach = vi.spyOn(giveUp.signal, 'removeEventListener');
    const call = outcomeOf(consumer.request('resolveOwner', { label: 'a' }, { signal: giveUp.signal }));
    await timers.advance(0);
    const asked = peer.heard.find(message => message.leg === 'request' && message.method === 'resolveOwner');
    if (asked === undefined) {
      throw new Error('no call heard');
    }
    const gaveUp = new Error('budget ran out');

    // When
    giveUp.abort(gaveUp);
    const late: WireMessage = {
      leg: 'response',
      id: asked.id,
      method: 'resolveOwner',
      outcome: { ok: true, answer: '5Grw' },
    };
    peer.send(late);
    peer.send(late);
    await timers.advance(0);

    // Then
    expect(await call).toBe(gaveUp);
    expect(count).not.toHaveBeenCalled();
    expect(peer.legs()).toEqual(['request:handshake', 'request:resolveOwner']);
    expect(detach).toHaveBeenCalledOnce();
    // A call still waiting would be settled again by the dispose, and detach its listener a second time.
    consumer.dispose(new Error('done'));
    expect(detach).toHaveBeenCalledOnce();
  });

  it('As a caller, aborting my queued calls before the handshake sends nothing for them', async () => {
    // Given
    const { consumer, timers, peer, answerHandshake } = rawRig();
    const giveUp = new AbortController();
    const call = outcomeOf(consumer.request('heartbeat', undefined, { signal: giveUp.signal }));
    const onEnd = vi.fn();
    consumer.subscribe('telemetry', undefined, () => undefined, { signal: giveUp.signal }).onEnd(onEnd);
    consumer.connect();
    await timers.advance(0);
    const reason = new Error('left the page');

    // When
    giveUp.abort(reason);
    answerHandshake();
    await consumer.whenConnected();
    await timers.advance(0);

    // Then
    expect(await call).toBe(reason);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(reason);
    expect(peer.legs()).toEqual(['request:handshake']);
  });

  it('As a caller, a call with an already aborted signal rejects at once and posts nothing', async () => {
    // Given
    const { consumer, timers, peer, answerHandshake } = rawRig();
    consumer.connect();
    await timers.advance(0);
    answerHandshake();
    await consumer.whenConnected();
    const reason = new Error('already gone');
    const signal = AbortSignal.abort(reason);
    const onEnd = vi.fn();

    // When
    const call = outcomeOf(consumer.request('heartbeat', undefined, { signal }));
    consumer.subscribe('telemetry', undefined, () => undefined, { signal }).onEnd(onEnd);
    await timers.advance(0);

    // Then
    expect(await call).toBe(reason);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(reason);
    expect(peer.legs()).toEqual(['request:handshake']);
  });

  it('As a caller, a provider that cannot post fails my handshake at once with why', async () => {
    // Given
    const { left } = createProviderPair();
    const broken = new Error('port closed');
    const provider: Provider = {
      ...left,
      post: () => {
        throw broken;
      },
    };
    const timers = manualTimers();
    const consumer = createConsumerTransport(provider, { side: 'frame', timers, count: vi.fn() });

    // When
    consumer.connect();
    const outcome = outcomeOf(consumer.whenConnected());
    await timers.advance(0);

    // Then
    expect(await outcome).toMatchObject({ cause: broken });
  });

  it('As either side, an unsubscribe crossing an end is ignored by both', async () => {
    // Given
    const { consumer, serving, timers, count } = rig();
    let sink: SubscriptionSink<'sharedAuthChanges'> | undefined;
    const stop = vi.fn();
    serving.handleSubscription('sharedAuthChanges', (_payload, _context, given) => {
      sink = given;
      return stop;
    });
    consumer.connect();
    const onEnd = vi.fn();
    const subscription = consumer.subscribe('sharedAuthChanges', undefined, () => undefined);
    subscription.onEnd(onEnd);
    await timers.advance(0);

    // When
    subscription.unsubscribe();
    sink?.end();
    await timers.advance(0);

    // Then
    expect(onEnd).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(count).not.toHaveBeenCalled();
  });

  it('As a subscriber, I hear events, then one end', async () => {
    // Given
    const { consumer, serving, timers } = rig();
    const sinks: SubscriptionSink<'resolveDotName'>[] = [];
    serving.handleSubscription('resolveDotName', (_payload, _context, sink) => {
      sinks.push(sink);
      return () => undefined;
    });
    consumer.connect();
    const events: SubscriptionEvent<'resolveDotName'>[] = [];
    const clean = consumer.subscribe('resolveDotName', { label: 'a' }, event => events.push(event));
    const failed = consumer.subscribe('resolveDotName', { label: 'b' }, () => undefined);
    const onCleanEnd = vi.fn();
    const onFailedEnd = vi.fn();
    clean.onEnd(onCleanEnd);
    failed.onEnd(onFailedEnd);
    await timers.advance(0);
    const [first, second] = sinks;

    // When
    first?.send({ tag: 'phase', value: 'resolving-content' });
    first?.send({ tag: 'resolved', value: 'bafy' });
    first?.end();
    first?.end(new Error('twice'));
    second?.end(new RangeError('no such name'));
    second?.end();
    await timers.advance(0);

    // Then
    expect(events).toEqual([
      { tag: 'phase', value: 'resolving-content' },
      { tag: 'resolved', value: 'bafy' },
    ]);
    expect(onCleanEnd).toHaveBeenCalledExactlyOnceWith(null);
    expect(onFailedEnd).toHaveBeenCalledOnce();
    expect(onFailedEnd.mock.calls[0]?.[0]).toBeInstanceOf(ProtocolRequestError);
    expect(onFailedEnd.mock.calls[0]?.[0]).toMatchObject({ name: 'RangeError', method: 'resolveDotName' });

    // When
    const late = vi.fn();
    failed.onEnd(late);

    // Then
    expect(late).toHaveBeenCalledExactlyOnceWith(onFailedEnd.mock.calls[0]?.[0]);
  });

  it('As a subscriber, unsubscribing while queued sends nothing', async () => {
    // Given
    const { consumer, timers, peer, answerHandshake } = rawRig();
    const onEnd = vi.fn();
    const subscription = consumer.subscribe('telemetry', undefined, () => undefined);
    subscription.onEnd(onEnd);
    consumer.connect();
    await timers.advance(0);

    // When
    subscription.unsubscribe();
    answerHandshake();
    await consumer.whenConnected();
    await timers.advance(0);

    // Then
    expect(peer.legs()).toEqual(['request:handshake']);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('As a subscriber, a listener that throws is reported and does not stop the others', async () => {
    // Given
    const { consumer, serving, timers, report } = rig();
    const sinks: SubscriptionSink<'sharedAuthChanges'>[] = [];
    serving.handleSubscription('sharedAuthChanges', (_payload, _context, sink) => {
      sinks.push(sink);
      return () => undefined;
    });
    consumer.connect();
    const throwing = vi.fn(() => {
      throw new Error('listener bug');
    });
    const heard = vi.fn();
    const first = consumer.subscribe('sharedAuthChanges', undefined, throwing);
    consumer.subscribe('sharedAuthChanges', undefined, heard);
    const endThrowing = vi.fn(() => {
      throw new Error('end listener bug');
    });
    const endHeard = vi.fn();
    first.onEnd(endThrowing);
    first.onEnd(endHeard);
    await timers.advance(0);
    const change = { siteId: 's', key: 'k', value: 'v' };

    // When
    for (const sink of sinks) {
      sink.send(change);
      sink.send(change);
    }
    sinks[0]?.end();
    await timers.advance(0);

    // Then
    expect(throwing).toHaveBeenCalledTimes(2);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(endThrowing).toHaveBeenCalledOnce();
    expect(endHeard).toHaveBeenCalledExactlyOnceWith(null);
    expect(report.mock.calls.map(([error]: unknown[]) => (error as Error).message)).toEqual([
      'listener bug',
      'listener bug',
      'end listener bug',
    ]);
  });

  it('As a caller, a payload that cannot be encoded rejects my call and posts nothing', async () => {
    // Given
    const { consumer, timers, delivered, serving } = rig();
    serving.handleRequest('heartbeat', () => undefined);
    const queuedBad = outcomeOf(consumer.request('resolveExecutableManifest', { label: 'a', kind: 'nope' as 'app' }));
    const queuedGood = consumer.request('heartbeat', undefined);
    consumer.connect();
    await timers.advance(0);
    expect(await queuedBad).toBeInstanceOf(RangeError);
    await expect(queuedGood).resolves.toBeUndefined();
    const posted = delivered.length;

    // When
    const bad = outcomeOf(consumer.request('resolveExecutableManifest', { label: 'a', kind: 'nope' as 'app' }));
    await timers.advance(0);

    // Then
    expect(await bad).toBeInstanceOf(RangeError);
    expect(delivered).toHaveLength(posted);
  });

  it('As a caller, a method the frame does not handle yet answers with an error at once', async () => {
    // Given
    const { consumer, timers } = rig();
    consumer.connect();
    const onEnd = vi.fn();

    // When
    const call = outcomeOf(consumer.request('warmup', undefined));
    consumer.subscribe('telemetry', undefined, () => undefined).onEnd(onEnd);
    await timers.advance(0);

    // Then
    expect(await call).toMatchObject({ method: 'warmup' });
    expect(await call).toBeInstanceOf(ProtocolRequestError);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd.mock.calls[0]?.[0]).toBeInstanceOf(ProtocolRequestError);
  });

  it('As a caller, every retry and flush posts a fresh buffer', async () => {
    // Given
    const { consumer, timers, peer, left, answerHandshake } = rawRig();
    const post = vi.spyOn(left, 'post');
    const calls = [
      consumer.request('heartbeat', undefined),
      consumer.request('heartbeat', undefined),
      consumer.request('heartbeat', undefined),
    ];
    const outcomes = calls.map(outcomeOf);

    // When
    consumer.connect();
    await timers.advance(RETRY_MS * 3);
    answerHandshake();
    await consumer.whenConnected();
    await timers.advance(0);

    // Then
    expect(peer.legs()).toEqual([
      'request:handshake',
      'request:handshake',
      'request:handshake',
      'request:handshake',
      'request:heartbeat',
      'request:heartbeat',
      'request:heartbeat',
    ]);
    expect(post.mock.results.every(result => result.type === 'return')).toBe(true);
    const done = new Error('done');
    consumer.dispose(done);
    expect(await Promise.all(outcomes)).toEqual([done, done, done]);
  });

  it('As a subscriber, I can unsubscribe and dispose from inside onEvent and onEnd', async () => {
    // Given
    const { consumer, serving, timers } = rig();
    const sinks: SubscriptionSink<'sharedAuthChanges'>[] = [];
    const stops: ReturnType<typeof vi.fn>[] = [];
    serving.handleSubscription('sharedAuthChanges', (_payload, _context, sink) => {
      sinks.push(sink);
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    });
    consumer.connect();
    const reason = new Error('torn down');
    const heardBySelfStopping = vi.fn();
    const selfStopping = consumer.subscribe('sharedAuthChanges', undefined, () => {
      heardBySelfStopping();
      selfStopping.unsubscribe();
      selfStopping.unsubscribe();
    });
    const disposing = consumer.subscribe('sharedAuthChanges', undefined, () => {
      consumer.dispose(reason);
    });
    const watcherEnds = vi.fn();
    let callFromEnd: Promise<unknown> | undefined;
    const watcher = consumer.subscribe('sharedAuthChanges', undefined, () => undefined);
    watcher.onEnd(error => {
      watcherEnds(error);
      watcher.unsubscribe();
      consumer.dispose(new Error('second dispose'));
      callFromEnd = outcomeOf(consumer.request('heartbeat', undefined));
    });
    const disposingEnds = vi.fn();
    disposing.onEnd(disposingEnds);
    await timers.advance(0);
    const change = { siteId: 's', key: 'k', value: 'v' };

    // When
    sinks[0]?.send(change);
    sinks[0]?.send(change);
    await timers.advance(0);
    sinks[1]?.send(change);
    await timers.advance(0);

    // Then
    expect(heardBySelfStopping).toHaveBeenCalledOnce();
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(disposingEnds).toHaveBeenCalledExactlyOnceWith(reason);
    expect(watcherEnds).toHaveBeenCalledExactlyOnceWith(reason);
    expect(await callFromEnd).toBe(reason);
  });

  it('As a subscriber, disposing from inside onEnd tells the frame only about what is still open', async () => {
    // Given
    const { consumer, timers, peer, answerHandshake } = rawRig();
    consumer.connect();
    await timers.advance(0);
    answerHandshake();
    await consumer.whenConnected();
    const ended = consumer.subscribe('sharedAuthChanges', undefined, () => undefined);
    consumer.subscribe('telemetry', undefined, () => undefined);
    ended.onEnd(() => {
      consumer.dispose(new Error('torn down'));
    });
    await timers.advance(0);
    const asked = peer.heard.find(message => message.leg === 'subscribe' && message.method === 'sharedAuthChanges');
    if (asked === undefined) {
      throw new Error('no subscribe heard');
    }

    // When
    peer.send({ leg: 'end', id: asked.id, method: 'sharedAuthChanges', error: null });
    await timers.advance(0);

    // Then
    expect(peer.legs().filter(leg => leg.startsWith('unsubscribe'))).toEqual(['unsubscribe:telemetry']);
  });
});
