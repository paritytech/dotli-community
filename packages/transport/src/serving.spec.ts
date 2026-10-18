// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { deferred, manualTimers, must } from '@dotli/shared/testing';
import { createProviderPair } from './provider.fake.js';
import type { Sink } from './serving.js';
import {
  cancelled,
  domain,
  err,
  hostFailure,
  malformedFrame,
  ok,
  unsupported,
  type CallError,
  type Result,
} from './result.js';
import {
  ECHO,
  LISTEN,
  NOTES,
  READ,
  TOUCH,
  VERSION,
  WATCH,
  breakable,
  outcomeOf,
  rawRig,
  rig,
  serveWatch,
  testSchema,
  watcher,
} from './testing/rig.js';
import { createTransport } from './transport.js';

/** A transport that accepted a raw peer's handshake. */
async function acceptedRaw(wrap?: Parameters<typeof rawRig>[1], watched?: Parameters<typeof rawRig>[2]) {
  const raw = rawRig('accept', wrap, watched);
  raw.openHandshake();
  await raw.timers.advance(0);
  return raw;
}

const answers = (messages: { id: number; body: unknown }[]) => messages.map(({ id, body }) => ({ id, body }));

describe('serving', () => {
  it("As a handler, I read the caller's origin and hello", async () => {
    // Given
    const { left, right } = createProviderPair();
    const timers = manualTimers();
    const opener = createTransport(
      testSchema,
      { ...left, peerOrigin: () => 'https://accepter.example' },
      { handshake: 'open', hello: 'opener', timers },
    );
    const accepter = createTransport(
      testSchema,
      { ...right, peerOrigin: () => 'https://opener.example' },
      { handshake: 'accept', hello: 'accepter' },
    );
    const servedByAccepter = vi.fn(() => ok('a'));
    const servedByOpener = vi.fn(() => ok('b'));
    accepter.handleRequest('echo', 'say', servedByAccepter);
    opener.handleRequest('echo', 'say', servedByOpener);
    opener.connect();

    // When
    const calls = [opener.request('echo', 'say', 'to the accepter'), accepter.request('echo', 'say', 'to the opener')];
    await timers.advance(0);
    await Promise.all(calls);

    // Then
    expect(servedByAccepter).toHaveBeenCalledExactlyOnceWith('to the accepter', {
      origin: 'https://opener.example',
      hello: 'opener',
    });
    expect(servedByOpener).toHaveBeenCalledExactlyOnceWith('to the opener', {
      origin: 'https://accepter.example',
      hello: 'accepter',
    });
  });

  it('As a serving side, a handler that throws or rejects answers HostFailure with its name and message, bounded', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    accepter.handleRequest('notes', 'read', () => {
      throw new TypeError('bad key');
    });
    accepter.handleRequest('echo', 'say', () => Promise.reject(new RangeError('x'.repeat(600))));
    opener.connect();

    // When
    const thrown = opener.request('notes', 'read', 'note');
    const rejected = opener.request('echo', 'say', 'text');
    await timers.advance(0);

    // Then
    expect(await thrown).toEqual(err(hostFailure('TypeError: bad key')));
    expect(await rejected).toEqual(err(hostFailure(`RangeError: ${'x'.repeat(500 - 'RangeError: '.length)}`)));
  });

  it('As a handler, an answer the wire cannot carry answers HostFailure with why', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    accepter.handleRequest('notes', 'read', () => err(cancelled()));
    // A domain error on a method that declares none, as an untyped caller could return.
    accepter.handleRequest('notes', 'touch', () => err(domain('undeclared')) as never);
    opener.connect();

    // When
    const read = opener.request('notes', 'read', 'note');
    const touch = opener.request('notes', 'touch', undefined);
    await timers.advance(0);

    // Then
    expect(await read).toEqual(
      err(hostFailure('TypeError: Cancelled is raised on the caller side and never crosses the wire')),
    );
    expect(await touch).toEqual(err(hostFailure('TypeError: the method declares no domain error')));
  });

  it('As a serving side, I refuse a second handler for one method', () => {
    // Given
    const { accepter } = rig();
    accepter.handleRequest('notes', 'read', () => ok('a'));
    accepter.handleSubscription('notes', 'watch', () => () => undefined);

    // When
    const second = () => accepter.handleRequest('notes', 'read', () => ok('b'));
    const secondSubscription = () => accepter.handleSubscription('notes', 'watch', () => () => undefined);

    // Then
    expect(second).toThrow('notes.read already has a handler');
    expect(secondSubscription).toThrow('notes.watch already has a handler');
  });

  it('As a serving side, I unregister a handler and a call then answers Unsupported', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    const first = vi.fn(() => ok('first'));
    const unregisterFirst = accepter.handleRequest('notes', 'read', first);
    unregisterFirst();
    const second = vi.fn(() => ok('second'));
    const unregisterSecond = accepter.handleRequest('notes', 'read', second);
    opener.connect();

    // When
    unregisterFirst();
    const answered = opener.request('notes', 'read', 'note');
    await timers.advance(0);

    // Then
    expect(await answered).toEqual(ok('second'));
    expect(first).not.toHaveBeenCalled();

    // When
    unregisterSecond();
    const refused = opener.request('notes', 'read', 'note');
    await timers.advance(0);

    // Then
    expect(await refused).toEqual(err(unsupported()));
  });

  it('As a handler, my answer after the transport is disposed is never posted', async () => {
    // Given
    const { opener, accepter, timers, delivered, issues } = rig();
    const answer = deferred<Result<string, CallError<string>>>();
    accepter.handleRequest('notes', 'read', () => answer.promise);
    opener.connect();
    void opener.request('notes', 'read', 'note');
    await timers.advance(0);
    const posted = delivered.length;

    // When
    accepter.dispose(new Error('the page is closing'));
    answer.resolve(ok('late'));
    await timers.advance(0);

    // Then
    expect(delivered).toHaveLength(posted);
    expect(issues).toEqual([]);
  });

  it('As a serving side, an answer my provider cannot post is reported and never left unhandled', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts } = breakable(broken);
    const { transport, timers, peer, issues } = await acceptedRaw(wrap);
    const answer = deferred<Result<void, CallError<never>>>();
    transport.handleRequest('notes', 'touch', () => answer.promise);
    peer.send({ kind: 'method', leg: 'request', id: 7, trait: NOTES, method: TOUCH, payload: undefined });
    await timers.advance(0);

    // When
    breakPosts();
    answer.resolve(ok());
    await timers.advance(0);

    // Then
    expect(issues).toEqual([{ kind: 'post_failed', leg: 'response', error: broken }]);
  });

  it("As a serving side, a payload that does not decode is answered MalformedFrame with the cause's message, and reported", async () => {
    // Given
    const { transport, timers, peer, issues } = await acceptedRaw();
    const handler = vi.fn(() => ok('never'));
    transport.handleRequest('notes', 'read', handler);

    // When a request on notes.read carries a payload that is no UTF-8
    peer.sendBytes(7, 0, 0, 0, NOTES, READ, 0, 0xff);
    await timers.advance(0);

    // Then
    expect(answers(peer.find('response:notes.read'))).toEqual([
      { id: 7, body: err(malformedFrame('The encoded data was not valid for encoding utf-8')) },
    ]);
    expect(issues).toEqual([{ kind: 'refused', reason: 'malformed', cause: expect.any(TypeError) as TypeError }]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('As a newer peer, my message for an unknown method is answered once on the protocol error address, and my reply to that is never answered', async () => {
    // Given
    const { timers, peer, issues } = await acceptedRaw();

    // When a method and a trait this schema lacks are called
    peer.sendBytes(9, 0, 0, 0, NOTES, 7, 0, 1, 2);
    peer.sendBytes(10, 0, 0, 0, 7, 0, 0);
    await timers.advance(0);

    // Then
    expect(answers(peer.find('response:255.255'))).toEqual([
      { id: 9, body: { trait: NOTES, method: 7 } },
      { id: 10, body: { trait: 7, method: 0 } },
    ]);

    // When the peer replies on the protocol error address
    peer.send({ kind: 'protocolError', id: 9, unsupportedMessage: { trait: 255, method: 255 } });
    peer.send({ kind: 'protocolError', id: 10, unsupportedMessage: { trait: 7, method: 0 } });
    await timers.advance(0);

    // Then
    expect(peer.legs()).toEqual(['response:255.0', 'response:255.255', 'response:255.255']);
    expect(issues).toEqual([]);
  });

  it('As a serving side, a request leg on a subscription method is refused as invalid with no reply', async () => {
    // Given
    const { timers, peer, issues } = await acceptedRaw();

    // When
    peer.sendBytes(5, 0, 0, 0, NOTES, WATCH, 0, 0x61);
    await timers.advance(0);

    // Then
    expect(issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(TypeError) as TypeError }]);
    expect(peer.legs()).toEqual(['response:255.0']);
  });

  it('As a serving side, a start with no handler is answered Unsupported, and one that does not decode MalformedFrame', async () => {
    // Given
    const { transport, timers, peer } = await acceptedRaw();
    const unregister = transport.handleSubscription('notes', 'watch', () => () => undefined);
    unregister();

    // When
    peer.send({ kind: 'method', leg: 'start', id: 4, trait: NOTES, method: WATCH, payload: 'from the top' });
    peer.sendBytes(5, 0, 0, 0, NOTES, WATCH, 2, 0xff);
    await timers.advance(0);

    // Then
    expect(answers(peer.find('interrupt:notes.watch'))).toEqual([
      { id: 4, body: err(unsupported()) },
      { id: 5, body: err(malformedFrame('The encoded data was not valid for encoding utf-8')) },
    ]);
  });

  it('As a serving side, a request before the handshake is refused as invalid with no reply', async () => {
    // Given
    const { transport, timers, peer, issues } = rawRig('accept');
    const handler = vi.fn(() => ok());
    transport.handleRequest('notes', 'touch', handler);

    // When a request, a start, a request whose payload is no UTF-8 and a request to a method this schema lacks come first
    peer.send({ kind: 'method', leg: 'request', id: 3, trait: NOTES, method: TOUCH, payload: undefined });
    peer.send({ kind: 'method', leg: 'start', id: 4, trait: NOTES, method: WATCH, payload: 'from the top' });
    peer.sendBytes(5, 0, 0, 0, NOTES, READ, 0, 0xff);
    peer.sendBytes(6, 0, 0, 0, NOTES, 7, 0, 1, 2);
    await timers.advance(0);

    // Then
    const refused = {
      kind: 'refused',
      reason: 'invalid',
      cause: expect.objectContaining({ message: 'A call came before the handshake' }) as Error,
    };
    expect(issues).toEqual([refused, refused, refused, refused]);
    expect(peer.heard).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('As a serving side, a call after my handshake failed is refused as invalid with the failure and no reply', async () => {
    // Given
    const { timers, peer, issues, openHandshake } = rawRig('accept');
    openHandshake(VERSION + 1);
    await timers.advance(0);

    // When
    peer.send({ kind: 'method', leg: 'request', id: 3, trait: NOTES, method: TOUCH, payload: undefined });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'invalid',
        cause: expect.objectContaining({
          message: `A call came after the transport closed, TransportVersionMismatchError: The peer speaks version ${String(VERSION + 1)} and this side ${String(VERSION)}`,
        }) as Error,
      },
    ]);
    expect(peer.legs()).toEqual(['response:255.0']);
  });

  it('As a connected accepter, a malformed handshake request is reported with no reply', async () => {
    // Given
    const { timers, peer, issues } = await acceptedRaw();

    // When a handshake request carries no version, then one carries a hello that is no UTF-8
    peer.sendBytes(2, 0, 0, 0, 255, 0, 0);
    peer.sendBytes(3, 0, 0, 0, 255, 0, 0, VERSION, 0xff);
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError },
      { kind: 'refused', reason: 'malformed', cause: expect.any(TypeError) as TypeError },
    ]);
    expect(peer.legs()).toEqual(['response:255.0']);
  });

  it('As a serving side, a message for an unknown address after my handshake failed is refused with no reply', async () => {
    // Given
    const { timers, peer, issues, openHandshake } = rawRig('accept');
    openHandshake(VERSION + 1);
    await timers.advance(0);

    // When an answer comes for a method this schema lacks
    peer.sendBytes(9, 0, 0, 0, NOTES, 7, 1, 0);
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'invalid',
        cause: expect.objectContaining({
          message: expect.stringMatching(
            /^A message for an unknown address came after the transport closed, /,
          ) as string,
        }) as Error,
      },
    ]);
    expect(peer.legs()).toEqual(['response:255.0']);
  });

  it('As an accepter, a malformed handshake request is reported with no reply', async () => {
    // Given
    const { transport, timers, peer, issues } = rawRig('accept');
    let connected = false;
    void transport.whenConnected().then(() => {
      connected = true;
    });

    // When a handshake request carries no version, then one carries a hello that is no UTF-8
    peer.sendBytes(1, 0, 0, 0, 255, 0, 0);
    peer.sendBytes(2, 0, 0, 0, 255, 0, 0, VERSION, 0xff);
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError },
      { kind: 'refused', reason: 'malformed', cause: expect.any(TypeError) as TypeError },
    ]);
    expect(peer.heard).toEqual([]);
    expect(connected).toBe(false);
  });

  it('As either side, a malformed or wrong-leg message on the protocol error address is reported with no reply', async () => {
    // Given
    const { timers, peer, issues } = await acceptedRaw();

    // When a protocol error has an unknown tag, then one comes on the request leg
    peer.sendBytes(2, 0, 0, 0, 255, 255, 1, 9, 0, 0);
    peer.sendBytes(3, 0, 0, 0, 255, 255, 0);
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError },
      { kind: 'refused', reason: 'invalid', cause: expect.any(TypeError) as TypeError },
    ]);
    expect(peer.legs()).toEqual(['response:255.0']);
  });

  it('As a serving side, I answer each call of the peer side by side', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    const slow = deferred<Result<string, CallError<never>>>();
    accepter.handleRequest('echo', 'say', text => (text === 'slow' ? slow.promise : ok(text)));
    opener.connect();
    const first = opener.request('echo', 'say', 'slow');

    // When
    const second = opener.request('echo', 'say', 'fast');
    await timers.advance(0);

    // Then
    expect(await second).toEqual(ok('fast'));

    // When
    slow.resolve(ok('slow'));

    // Then
    expect(await first).toEqual(ok('slow'));
  });

  it("As a handler, I read the subscriber's start, origin and hello, and the peer's stop runs my stop function once", async () => {
    // Given
    const { transport, timers, peer, issues } = await acceptedRaw();
    const started: unknown[] = [];
    const stop = vi.fn();
    transport.handleSubscription('notes', 'watch', (start, context) => {
      started.push({ start, context });
      return stop;
    });
    peer.send({ kind: 'method', leg: 'start', id: 4, trait: NOTES, method: WATCH, payload: 'from the top' });
    await timers.advance(0);

    // When
    peer.send({ kind: 'method', leg: 'stop', id: 4, trait: NOTES, method: WATCH });
    peer.send({ kind: 'method', leg: 'stop', id: 4, trait: NOTES, method: WATCH });
    await timers.advance(0);

    // Then the second stop is the peer's fault
    expect(started).toEqual([{ start: 'from the top', context: { origin: null, hello: 'peer' } }]);
    expect(stop).toHaveBeenCalledOnce();
    expect(peer.legs()).toEqual(['response:255.0']);
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'invalid',
        cause: expect.objectContaining({ message: 'A stop names subscription 4, which is not running' }) as Error,
      },
    ]);
  });

  it('As a serving side, a handler that throws on start interrupts with HostFailure', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    accepter.handleSubscription('notes', 'watch', () => {
      throw new TypeError('bad start');
    });
    opener.connect();
    const heard = watcher();

    // When
    opener.subscribe('notes', 'watch', 'from the top', heard);
    await timers.advance(0);

    // Then
    expect(heard.ends).toEqual([err(hostFailure('TypeError: bad start'))]);
    expect(issues).toEqual([]);
  });

  it('As a handler, I interrupt inside start and my stop function still runs once', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const stop = vi.fn();
    accepter.handleSubscription('notes', 'watch', (_start, _context, sink) => {
      sink.receive('only');
      sink.interrupt(domain('at once'));
      return stop;
    });
    opener.connect();
    const heard = watcher();

    // When
    opener.subscribe('notes', 'watch', 'from the top', heard);
    await timers.advance(0);

    // Then
    expect(heard.values).toEqual(['only']);
    expect(heard.ends).toEqual([err(domain('at once'))]);
    expect(stop).toHaveBeenCalledOnce();
    expect(issues).toEqual([]);
  });

  it('As either side, a stop crossing an interrupt is ignored by both', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const { sinks, stops } = serveWatch(accepter);
    opener.connect();
    const heard = watcher();
    const handle = opener.subscribe('notes', 'watch', 'from the top', heard);
    await timers.advance(0);

    // When
    handle.stop();
    must(sinks[0], 'a sink').interrupt();
    await timers.advance(0);

    // Then
    expect(heard.ends).toEqual([]);
    expect(stops).toEqual([1]);
    expect(issues).toEqual([]);
  });

  it('As a handler, my receive and interrupt after the subscription stopped do nothing', async () => {
    // Given
    const { opener, accepter, timers, delivered } = rig();
    const { sinks, stops } = serveWatch(accepter);
    opener.connect();
    const handle = opener.subscribe('notes', 'watch', 'from the top', watcher());
    await timers.advance(0);
    handle.stop();
    await timers.advance(0);
    const posted = delivered.length;

    // When
    const sink = must(sinks[0], 'a sink');
    sink.receive('late');
    sink.interrupt();
    sink.interrupt(domain('again'));
    await timers.advance(0);

    // Then
    expect(delivered).toHaveLength(posted);
    expect(stops).toEqual([1]);
  });

  it('As a handler, a value or an interrupt the wire cannot carry interrupts with HostFailure with why and runs my stop', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    const { sinks, stops } = serveWatch(accepter);
    opener.connect();
    const first = watcher();
    const second = watcher();
    opener.subscribe('notes', 'watch', 'a', first);
    opener.subscribe('notes', 'watch', 'b', second);
    await timers.advance(0);

    // When
    must(sinks[0], 'the first sink').receive('');
    must(sinks[1], 'the second sink').interrupt(cancelled());
    await timers.advance(0);

    // Then
    expect(first.ends).toEqual([err(hostFailure('RangeError: A word is never empty'))]);
    expect(second.ends).toEqual([
      err(hostFailure('TypeError: Cancelled is raised on the caller side and never crosses the wire')),
    ]);
    expect(stops).toEqual([1, 1]);
  });

  it('As a handler, a value or an interrupt my provider cannot post is reported and never thrown into my call', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts } = breakable(broken);
    const { transport, timers, peer, issues } = await acceptedRaw(wrap);
    const { sinks, stops } = serveWatch(transport);
    peer.send({ kind: 'method', leg: 'start', id: 4, trait: NOTES, method: WATCH, payload: 'from the top' });
    await timers.advance(0);
    breakPosts();
    const sink = must(sinks[0], 'a sink');

    // When
    const receive = (): void => {
      sink.receive('a line');
    };
    const interrupt = (): void => {
      sink.interrupt();
    };

    // Then
    expect(receive).not.toThrow();
    expect(interrupt).not.toThrow();
    expect(issues).toEqual([
      { kind: 'post_failed', leg: 'receive', error: broken },
      { kind: 'post_failed', leg: 'interrupt', error: broken },
    ]);
    expect(stops).toEqual([1]);
  });

  it('As a serving side, disposing interrupts each subscription I serve with HostFailure carrying the reason and runs its stop', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const { stops } = serveWatch(accepter);
    opener.connect();
    const heard = [watcher(), watcher()];
    for (const listeners of heard) {
      opener.subscribe('notes', 'watch', 'from the top', listeners);
    }
    await timers.advance(0);

    // When
    accepter.dispose(new RangeError('upstream gone'));
    await timers.advance(0);

    // Then
    expect(stops).toEqual([1, 1]);
    for (const listeners of heard) {
      expect(listeners.ends).toEqual([err(hostFailure('RangeError: upstream gone'))]);
    }
    expect(issues).toEqual([]);
  });

  it('As a serving side, a stop function that throws is reported as listener_threw and the others still run', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const bug = new Error('stop bug');
    const stops = [
      vi.fn(() => {
        throw bug;
      }),
      vi.fn(),
    ];
    let started = 0;
    accepter.handleSubscription('notes', 'watch', () => {
      const stop = stops[started] ?? (() => undefined);
      started += 1;
      return stop;
    });
    opener.connect();
    opener.subscribe('notes', 'watch', 'a', watcher());
    opener.subscribe('notes', 'watch', 'b', watcher());
    await timers.advance(0);

    // When
    accepter.dispose(new Error('the page is closing'));

    // Then
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(stops[1]).toHaveBeenCalledOnce();
    expect(issues).toEqual([{ kind: 'listener_threw', error: bug }]);
  });

  it('As a serving side, a start that reuses the id of a running subscription, or a stop that names another method, is refused as invalid with no reply', async () => {
    // Given
    const { transport, timers, peer, issues } = await acceptedRaw();
    const { starts, stops } = serveWatch(transport);
    peer.send({ kind: 'method', leg: 'start', id: 4, trait: NOTES, method: WATCH, payload: 'first' });
    await timers.advance(0);

    // When
    peer.send({ kind: 'method', leg: 'start', id: 4, trait: NOTES, method: WATCH, payload: 'second' });
    peer.send({ kind: 'method', leg: 'stop', id: 4, trait: ECHO, method: LISTEN });
    await timers.advance(0);

    // Then
    expect(starts).toEqual(['first']);
    expect(stops).toEqual([0]);
    const refused = { kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error };
    expect(issues).toEqual([refused, refused]);
    expect(peer.legs()).toEqual(['response:255.0']);
  });

  it('As a serving side, I hear that a disposed peer left once its last stop and its last call are done', async () => {
    // Given a peer with two subscriptions and a call this side still holds
    const onPeerIdle = vi.fn();
    const { opener, accepter, timers } = rig({ onPeerIdle });
    serveWatch(accepter);
    const held = deferred<Result<void, CallError<never>>>();
    accepter.handleRequest('notes', 'touch', () => held.promise);
    opener.connect();
    opener.subscribe('notes', 'watch', 'status', watcher());
    opener.subscribe('notes', 'watch', 'tick', watcher());
    void outcomeOf(opener.request('notes', 'touch', undefined));
    await timers.advance(0);

    // When the peer disposes its transport
    opener.dispose(new Error('leaving'));
    await timers.advance(0);

    // Then the call in flight holds the peer
    expect(onPeerIdle).not.toHaveBeenCalled();

    // When the call settles
    held.resolve(ok());
    await timers.advance(0);

    // Then the peer is gone, once
    expect(onPeerIdle).toHaveBeenCalledOnce();
  });

  it('As a serving side, I do not take a peer for gone when I ended its subscriptions myself', async () => {
    // Given a peer with two subscriptions
    const onPeerIdle = vi.fn();
    const { opener, accepter, timers } = rig({ onPeerIdle });
    const { sinks } = serveWatch(accepter);
    opener.connect();
    const heard = [watcher(), watcher()];
    for (const listeners of heard) {
      opener.subscribe('notes', 'watch', 'tick', listeners);
    }
    await timers.advance(0);

    // When this side ends both
    for (const sink of sinks) {
      sink.interrupt();
    }
    await timers.advance(0);

    // Then the peer heard both ends and is not taken for gone
    for (const listeners of heard) {
      expect(listeners.ends).toEqual([ok()]);
    }
    expect(onPeerIdle).not.toHaveBeenCalled();

    // When it subscribes again and leaves that one
    const again = opener.subscribe('notes', 'watch', 'tick', watcher());
    await timers.advance(0);
    again.stop();
    await timers.advance(0);

    // Then it is
    expect(onPeerIdle).toHaveBeenCalledOnce();
  });

  it('As a serving side, I take a disposed peer for gone when I ended one of its subscriptions before its stop came', async () => {
    // Given a peer with a status and a read, over a raw peer the test speaks for
    const onPeerIdle = vi.fn();
    const { transport, timers, peer } = await acceptedRaw(undefined, { onPeerIdle });
    const { sinks } = serveWatch(transport);
    peer.send({ kind: 'method', leg: 'start', id: 1, trait: NOTES, method: WATCH, payload: 'status' });
    peer.send({ kind: 'method', leg: 'start', id: 2, trait: NOTES, method: WATCH, payload: 'read' });
    await timers.advance(0);

    // When the peer stops its status, the read ends here, and then the peer's stop for the read arrives
    peer.send({ kind: 'method', leg: 'stop', id: 1, trait: NOTES, method: WATCH });
    await timers.advance(0);
    must(sinks[1], 'the read').interrupt();
    peer.send({ kind: 'method', leg: 'stop', id: 2, trait: NOTES, method: WATCH });
    await timers.advance(0);

    // Then the peer is gone, once
    expect(onPeerIdle).toHaveBeenCalledOnce();
  });

  it('As a serving side, I keep a peer that left its last subscription with a call held and goes on making calls', async () => {
    // Given a peer whose last subscription it leaves while a call is held
    const onPeerIdle = vi.fn();
    const { opener, accepter, timers } = rig({ onPeerIdle });
    serveWatch(accepter);
    const held = deferred<Result<void, CallError<never>>>();
    accepter.handleRequest('notes', 'touch', () => held.promise);
    accepter.handleRequest('echo', 'say', text => ok(text));
    opener.connect();
    const ticks = opener.subscribe('notes', 'watch', 'tick', watcher());
    const touched = opener.request('notes', 'touch', undefined);
    await timers.advance(0);
    ticks.stop();
    await timers.advance(0);

    // When it makes another call, and both settle
    await opener.request('echo', 'say', 'still here');
    held.resolve(ok());
    await touched;
    await timers.advance(0);

    // Then it is not taken for gone
    expect(onPeerIdle).not.toHaveBeenCalled();
  });

  it('As a serving side, a peer idle hook that throws is reported as listener_threw, and none is heard once I am disposed', async () => {
    // Given
    const bug = new Error('idle bug');
    const onPeerIdle = vi.fn(() => {
      throw bug;
    });
    const { transport, timers, peer, issues } = await acceptedRaw(undefined, { onPeerIdle });
    serveWatch(transport);
    const held = deferred<Result<void, CallError<never>>>();
    transport.handleRequest('notes', 'touch', () => held.promise);
    peer.send({ kind: 'method', leg: 'start', id: 1, trait: NOTES, method: WATCH, payload: 'tick' });
    await timers.advance(0);

    // When the peer leaves
    peer.send({ kind: 'method', leg: 'stop', id: 1, trait: NOTES, method: WATCH });
    await timers.advance(0);

    // Then
    expect(onPeerIdle).toHaveBeenCalledOnce();
    expect(issues).toEqual([{ kind: 'listener_threw', error: bug }]);

    // When it calls, starts and leaves again, and this side is disposed before its call settles
    peer.send({ kind: 'method', leg: 'request', id: 2, trait: NOTES, method: TOUCH, payload: undefined });
    peer.send({ kind: 'method', leg: 'start', id: 3, trait: NOTES, method: WATCH, payload: 'tick' });
    peer.send({ kind: 'method', leg: 'stop', id: 3, trait: NOTES, method: WATCH });
    await timers.advance(0);
    transport.dispose(new Error('the page is closing'));
    held.resolve(ok());
    await timers.advance(0);

    // Then
    expect(onPeerIdle).toHaveBeenCalledOnce();
  });

  it('As a handler, my stop function that disposes the transport still lets the peer hear my interrupt', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const sinks: Sink<string, string>[] = [];
    accepter.handleSubscription('notes', 'watch', (_start, _context, sink) => {
      sinks.push(sink);
      return () => {
        accepter.dispose(new Error('done here'));
      };
    });
    opener.connect();
    const ended = watcher();
    const other = watcher();
    opener.subscribe('notes', 'watch', 'a', ended);
    opener.subscribe('notes', 'watch', 'b', other);
    await timers.advance(0);

    // When
    must(sinks[0], 'the first sink').interrupt(domain('finished'));
    await timers.advance(0);

    // Then
    expect(ended.ends).toEqual([err(domain('finished'))]);
    expect(other.ends).toEqual([err(hostFailure('Error: done here'))]);
    expect(issues).toEqual([]);
  });

  it('As a serving side, I hear a peer leave once when its stops cross my interrupt, and again once it calls anew', async () => {
    // Given
    const onPeerIdle = vi.fn();
    const { transport, timers, peer } = await acceptedRaw(undefined, { onPeerIdle });
    const { sinks } = serveWatch(transport);
    peer.send({ kind: 'method', leg: 'start', id: 1, trait: NOTES, method: WATCH, payload: 'status' });
    peer.send({ kind: 'method', leg: 'start', id: 2, trait: NOTES, method: WATCH, payload: 'read' });
    await timers.advance(0);

    // When this side ends the read, and the peer's stops for both arrive after
    must(sinks[1], 'the read').interrupt();
    peer.send({ kind: 'method', leg: 'stop', id: 1, trait: NOTES, method: WATCH });
    peer.send({ kind: 'method', leg: 'stop', id: 2, trait: NOTES, method: WATCH });
    await timers.advance(0);

    // Then
    expect(onPeerIdle).toHaveBeenCalledOnce();

    // When it starts and leaves again
    peer.send({ kind: 'method', leg: 'start', id: 3, trait: NOTES, method: WATCH, payload: 'tick' });
    peer.send({ kind: 'method', leg: 'stop', id: 3, trait: NOTES, method: WATCH });
    await timers.advance(0);

    // Then
    expect(onPeerIdle).toHaveBeenCalledTimes(2);
  });

  it('As a serving side, a stop before the handshake or for a subscription that is not running is refused as invalid, and I hear no peer leave', async () => {
    // Given
    const onPeerIdle = vi.fn();
    const { timers, peer, issues, openHandshake } = rawRig('accept', undefined, { onPeerIdle });

    // When a stop comes before the handshake, then one names an id never started
    peer.send({ kind: 'method', leg: 'stop', id: 1, trait: NOTES, method: WATCH });
    await timers.advance(0);
    openHandshake();
    await timers.advance(0);
    peer.send({ kind: 'method', leg: 'stop', id: 2, trait: NOTES, method: WATCH });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'invalid',
        cause: expect.objectContaining({ message: 'A stop came before the handshake' }) as Error,
      },
      {
        kind: 'refused',
        reason: 'invalid',
        cause: expect.objectContaining({ message: 'A stop names subscription 2, which is not running' }) as Error,
      },
    ]);
    expect(onPeerIdle).not.toHaveBeenCalled();
    expect(peer.legs()).toEqual(['response:255.0']);
  });

  it('As a serving side, a call that does not decode or names an address I lack still keeps the peer', async () => {
    // Given a peer that leaves its last subscription while a call is held
    const onPeerIdle = vi.fn();
    const { transport, timers, peer } = await acceptedRaw(undefined, { onPeerIdle });
    serveWatch(transport);
    const releases: (() => void)[] = [];
    transport.handleRequest(
      'notes',
      'touch',
      () =>
        new Promise<Result<void, CallError<never>>>(resolve => {
          releases.push(() => {
            resolve(ok());
          });
        }),
    );
    const leaveWithCallHeld = async (id: number): Promise<void> => {
      peer.send({ kind: 'method', leg: 'request', id, trait: NOTES, method: TOUCH, payload: undefined });
      peer.send({ kind: 'method', leg: 'start', id: id + 1, trait: NOTES, method: WATCH, payload: 'tick' });
      peer.send({ kind: 'method', leg: 'stop', id: id + 1, trait: NOTES, method: WATCH });
      await timers.advance(0);
    };
    await leaveWithCallHeld(1);

    // When it makes a call whose payload is no UTF-8, and the held call settles
    peer.sendBytes(5, 0, 0, 0, NOTES, READ, 0, 0xff);
    await timers.advance(0);
    releases[0]?.();
    await timers.advance(0);

    // Then
    expect(onPeerIdle).not.toHaveBeenCalled();

    // When it leaves again and then calls a method this schema lacks
    await leaveWithCallHeld(6);
    peer.sendBytes(9, 0, 0, 0, NOTES, 7, 0, 1, 2);
    await timers.advance(0);
    releases[1]?.();
    await timers.advance(0);

    // Then
    expect(onPeerIdle).not.toHaveBeenCalled();
  });
});
