// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ResultPayload } from 'scale-ts';
import { describe, expect, it, vi } from 'vitest';
import { deferred, manualTimers, must } from '@dotli/shared/testing';
import { createProviderPair } from './provider.fake.js';
import type { Sink } from './serving.js';
import { cancelled, domain, err, hostFailure, malformedFrame, ok, unsupported, type CallError } from './result.js';
import {
  breakable,
  echo,
  notes,
  CUT_SHORT_TEXT,
  NOTES,
  outcomeOf,
  rawRig,
  rig,
  serveWatch,
  testSchema,
  VERSION,
  watcher,
  rawRead,
  rawWatch,
} from './testing/rig.js';
import { createTransport } from './transport.js';

/** A transport that accepted a raw peer's handshake. */
async function acceptedRaw(wrap?: Parameters<typeof rawRig>[1], watched?: Parameters<typeof rawRig>[2]) {
  const raw = rawRig('accept', wrap, watched);
  raw.openHandshake();
  await raw.timers.advance(0);
  return raw;
}

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
    accepter.handleRequest(echo.say, servedByAccepter);
    opener.handleRequest(echo.say, servedByOpener);
    opener.connect();

    // When
    const calls = [opener.request(echo.say, 'to the accepter'), accepter.request(echo.say, 'to the opener')];
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
    accepter.handleRequest(notes.read, () => {
      throw new TypeError('bad key');
    });
    accepter.handleRequest(echo.say, () => Promise.reject(new RangeError('x'.repeat(600))));
    opener.connect();

    // When
    const thrown = opener.request(notes.read, 'note');
    const rejected = opener.request(echo.say, 'text');
    await timers.advance(0);

    // Then
    expect(await thrown).toEqual(err(hostFailure('TypeError: bad key')));
    expect(await rejected).toEqual(err(hostFailure(`RangeError: ${'x'.repeat(500 - 'RangeError: '.length)}`)));
  });

  it('As a relaying handler, I answer with the Cancelled my own call ended with and the caller hears it', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    accepter.handleRequest(notes.read, () => err(cancelled()));
    opener.connect();

    // When
    const read = opener.request(notes.read, 'note');
    await timers.advance(0);

    // Then
    expect(await read).toEqual(err(cancelled()));
  });

  it('As a serving side, I refuse a second handler for one method', () => {
    // Given
    const { accepter } = rig();
    accepter.handleRequest(notes.read, () => ok('a'));
    accepter.handleSubscription(notes.watch, () => () => undefined);

    // When
    const second = () => accepter.handleRequest(notes.read, () => ok('b'));
    const secondSubscription = () => accepter.handleSubscription(notes.watch, () => () => undefined);

    // Then
    expect(second).toThrow('notes.read already has a handler');
    expect(secondSubscription).toThrow('notes.watch already has a handler');
  });

  it('As a serving side, I unregister a handler and a call then answers Unsupported', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    const first = vi.fn(() => ok('first'));
    const unregisterFirst = accepter.handleRequest(notes.read, first);
    unregisterFirst();
    const second = vi.fn(() => ok('second'));
    const unregisterSecond = accepter.handleRequest(notes.read, second);
    opener.connect();

    // When
    unregisterFirst();
    const answered = opener.request(notes.read, 'note');
    await timers.advance(0);

    // Then
    expect(await answered).toEqual(ok('second'));
    expect(first).not.toHaveBeenCalled();

    // When
    unregisterSecond();
    const refused = opener.request(notes.read, 'note');
    await timers.advance(0);

    // Then
    expect(await refused).toEqual(err(unsupported()));
  });

  it('As a caller, my call in flight when the peer disposes fails with the reason, and the late answer is never posted', async () => {
    // Given
    const { opener, accepter, timers, delivered, issues } = rig();
    const answer = deferred<ResultPayload<string, CallError<string>>>();
    accepter.handleRequest(notes.read, () => answer.promise);
    opener.connect();
    const call = opener.request(notes.read, 'note');
    await timers.advance(0);
    const posted = delivered.length;

    // When
    accepter.dispose(new Error('the page is closing'));
    answer.resolve(ok('late'));
    await timers.advance(0);

    // Then
    expect(await call).toEqual(err(hostFailure('Error: the page is closing')));
    expect(delivered).toHaveLength(posted + 1);
    expect(issues).toEqual([]);
  });

  it('As a serving side, an answer my provider cannot post is reported and never left unhandled', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts } = breakable(broken);
    const { transport, timers, peer, issues } = await acceptedRaw(wrap);
    const answer = deferred<ResultPayload<undefined, CallError<undefined>>>();
    transport.handleRequest(notes.touch, () => answer.promise);
    peer.call(notes.touch, 7, { tag: 'request', value: undefined });
    await timers.advance(0);

    // When
    breakPosts();
    answer.resolve(ok());
    await timers.advance(0);

    // Then
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { trait: 'notes', method: 'touch' } }]);
  });

  it("As a serving side, a payload that does not decode is answered MalformedFrame with the cause's message, and reported", async () => {
    // Given
    const { transport, timers, peer, issues } = await acceptedRaw();
    const handler = vi.fn(() => ok('never'));
    transport.handleRequest(notes.read, handler);

    // When a request on notes.read carries a payload that is cut short
    peer.call(rawRead, 7, { tag: 'request', value: CUT_SHORT_TEXT }, notes.read);
    await timers.advance(0);

    // Then
    expect(peer.failures()).toEqual([{ id: 7, value: malformedFrame('RangeError: Invalid DataView length 2') }]);
    expect(issues).toEqual([{ kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError }]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('As a serving side, a call to a method or a trait this schema lacks is answered Unsupported, and a failure about a call I never made is refused', async () => {
    // Given
    const { timers, peer, issues } = await acceptedRaw();

    // When a method and a trait this schema lacks are called
    peer.send(9, { tag: 'call', value: { trait: NOTES, method: 7, message: Uint8Array.of(0, 1, 2) } });
    peer.send(11, { tag: 'call', value: { trait: 7, method: 0, message: Uint8Array.of(0) } });
    await timers.advance(0);

    // Then
    expect(peer.failures()).toEqual([
      { id: 9, value: unsupported() },
      { id: 11, value: unsupported() },
    ]);

    // When the peer fails a call this side never made
    peer.send(4, { tag: 'failed', value: unsupported() });
    await timers.advance(0);

    // Then
    expect(peer.names()).toEqual(['accept', 'failed', 'failed']);
    expect(issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error }]);
  });

  it('As a serving side, a message of a kind its method lacks is answered MalformedFrame, and a response to the peer is refused as invalid', async () => {
    // Given
    const { transport, timers, peer, issues } = await acceptedRaw();
    serveWatch(transport);
    transport.handleRequest(notes.read, () => ok('never'));

    // When a message on notes.watch has a kind no subscription has, and a response comes for a call of the peer's
    peer.send(5, { tag: 'call', value: { trait: NOTES, method: 2, message: Uint8Array.of(4, 0x61) } });
    peer.call(notes.read, 7, { tag: 'response', value: ok('a note') });
    await timers.advance(0);

    // Then
    expect(peer.failures()).toEqual([{ id: 5, value: expect.objectContaining({ tag: 'MalformedFrame' }) as object }]);
    expect(issues).toEqual([
      { kind: 'refused', reason: 'malformed', cause: expect.any(TypeError) as TypeError },
      { kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error },
    ]);
  });

  it('As a serving side, a start with no handler is answered Unsupported, and one that does not decode MalformedFrame', async () => {
    // Given
    const { transport, timers, peer } = await acceptedRaw();
    const unregister = transport.handleSubscription(notes.watch, () => () => undefined);
    unregister();
    peer.call(notes.watch, 5, { tag: 'start', value: 'from the top' });
    await timers.advance(0);
    serveWatch(transport);

    // When
    peer.call(rawWatch, 7, { tag: 'start', value: CUT_SHORT_TEXT }, notes.watch);
    await timers.advance(0);

    // Then
    expect(peer.failures()).toEqual([
      { id: 5, value: unsupported() },
      { id: 7, value: malformedFrame('RangeError: Invalid DataView length 2') },
    ]);
  });

  it('As a serving side, a call before the handshake is refused as invalid with no reply', async () => {
    // Given
    const { transport, timers, peer, issues } = rawRig('accept');
    const handler = vi.fn(() => ok());
    transport.handleRequest(notes.touch, handler);

    // When a request, a start, a request whose payload is cut short and a request to a method this schema lacks come first
    peer.call(notes.touch, 3, { tag: 'request', value: undefined });
    peer.call(notes.watch, 5, { tag: 'start', value: 'from the top' });
    peer.call(rawRead, 7, { tag: 'request', value: CUT_SHORT_TEXT }, notes.read);
    peer.send(9, { tag: 'call', value: { trait: NOTES, method: 7, message: Uint8Array.of(0, 1, 2) } });
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

    // When a call comes on a method of the schema and on one it lacks
    peer.call(notes.touch, 3, { tag: 'request', value: undefined });
    peer.send(5, { tag: 'call', value: { trait: NOTES, method: 7, message: Uint8Array.of(1, 0) } });
    await timers.advance(0);

    // Then
    const refused = {
      kind: 'refused',
      reason: 'invalid',
      cause: expect.objectContaining({
        message: `A call came after the transport closed, TransportVersionMismatchError: The peer speaks version ${String(VERSION + 1)} and this side ${String(VERSION)}`,
      }) as Error,
    };
    expect(issues).toEqual([refused, refused]);
    expect(peer.names()).toEqual(['accept']);
  });

  it('As a connected accepter, a malformed handshake open is reported with no reply', async () => {
    // Given
    const { timers, peer, issues } = await acceptedRaw();

    // When an open carries no version, then one carries a hello that is cut short
    peer.sendBytes(3, 0, 0, 0, 0);
    peer.send(5, { tag: 'open', value: { version: VERSION, hello: CUT_SHORT_TEXT } });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError },
      { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError },
    ]);
    expect(peer.names()).toEqual(['accept']);
  });

  it('As an accepter, a malformed handshake open is reported with no reply', async () => {
    // Given
    const { transport, timers, peer, issues } = rawRig('accept');
    let connected = false;
    void transport.whenConnected().then(() => {
      connected = true;
    });

    // When an open carries no version, then one carries a hello that is cut short
    peer.sendBytes(1, 0, 0, 0, 0);
    peer.send(3, { tag: 'open', value: { version: VERSION, hello: CUT_SHORT_TEXT } });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError },
      { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError },
    ]);
    expect(peer.heard).toEqual([]);
    expect(connected).toBe(false);
  });

  it('As either side, a frame of a kind the wire lacks is reported as malformed with no reply', async () => {
    // Given
    const { timers, peer, issues } = await acceptedRaw();

    // When a frame has a kind past the call, then a failure has a variant CallError lacks
    peer.sendBytes(3, 0, 0, 0, 4);
    peer.sendBytes(5, 0, 0, 0, 2, 9);
    await timers.advance(0);

    // Then
    const refused = { kind: 'refused', reason: 'malformed', cause: expect.any(TypeError) as TypeError };
    expect(issues).toEqual([refused, refused]);
    expect(peer.names()).toEqual(['accept']);
  });

  it('As a serving side, I answer each call of the peer side by side', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    const slow = deferred<ResultPayload<string, CallError<undefined>>>();
    accepter.handleRequest(echo.say, text => (text === 'slow' ? slow.promise : ok(text)));
    opener.connect();
    const first = opener.request(echo.say, 'slow');

    // When
    const second = opener.request(echo.say, 'fast');
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
    transport.handleSubscription(notes.watch, (start, context) => {
      started.push({ start, context });
      return stop;
    });
    peer.call(notes.watch, 5, { tag: 'start', value: 'from the top' });
    await timers.advance(0);

    // When
    peer.call(notes.watch, 5, { tag: 'stop', value: undefined });
    peer.call(notes.watch, 5, { tag: 'stop', value: undefined });
    await timers.advance(0);

    // Then the second stop is the peer's fault
    expect(started).toEqual([{ start: 'from the top', context: { origin: null, hello: 'peer' } }]);
    expect(stop).toHaveBeenCalledOnce();
    expect(peer.names()).toEqual(['accept']);
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'invalid',
        cause: expect.objectContaining({ message: 'A stop names subscription 5, which is not running' }) as Error,
      },
    ]);
  });

  it('As a serving side, a handler that throws on start interrupts with HostFailure', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    accepter.handleSubscription(notes.watch, () => {
      throw new TypeError('bad start');
    });
    opener.connect();
    const heard = watcher();

    // When
    opener.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);

    // Then
    expect(heard.ends).toEqual([err(hostFailure('TypeError: bad start'))]);
    expect(issues).toEqual([]);
  });

  it('As a handler, I interrupt inside start and my stop function still runs once', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const stop = vi.fn();
    accepter.handleSubscription(notes.watch, (_start, _context, sink) => {
      sink.receive('only');
      sink.interrupt(err(domain('at once')));
      return stop;
    });
    opener.connect();
    const heard = watcher();

    // When
    opener.subscribe(notes.watch, 'from the top', heard);
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
    const handle = opener.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);

    // When
    handle.stop();
    must(sinks[0], 'a sink').interrupt(ok());
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
    const handle = opener.subscribe(notes.watch, 'from the top', watcher());
    await timers.advance(0);
    handle.stop();
    await timers.advance(0);
    const posted = delivered.length;

    // When
    const sink = must(sinks[0], 'a sink');
    sink.receive('late');
    sink.interrupt(ok());
    sink.interrupt(err(domain('again')));
    await timers.advance(0);

    // Then
    expect(delivered).toHaveLength(posted);
    expect(stops).toEqual([1]);
  });

  it('As a handler, a value the wire cannot carry interrupts with HostFailure with why, and every end runs my stop', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    const { sinks, stops } = serveWatch(accepter);
    opener.connect();
    const first = watcher();
    const second = watcher();
    opener.subscribe(notes.watch, 'a', first);
    opener.subscribe(notes.watch, 'b', second);
    await timers.advance(0);

    // When
    must(sinks[0], 'the first sink').receive('');
    must(sinks[1], 'the second sink').interrupt(err(cancelled()));
    await timers.advance(0);

    // Then
    expect(first.ends).toEqual([err(hostFailure('RangeError: A word is never empty'))]);
    expect(second.ends).toEqual([err(cancelled())]);
    expect(stops).toEqual([1, 1]);
  });

  it('As a handler, a value or an interrupt my provider cannot post is reported and never thrown into my call', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts } = breakable(broken);
    const { transport, timers, peer, issues } = await acceptedRaw(wrap);
    const { sinks, stops } = serveWatch(transport);
    peer.call(notes.watch, 5, { tag: 'start', value: 'from the top' });
    await timers.advance(0);
    breakPosts();
    const sink = must(sinks[0], 'a sink');

    // When
    const receive = (): void => {
      sink.receive('a line');
    };
    const interrupt = (): void => {
      sink.interrupt(ok());
    };

    // Then
    expect(receive).not.toThrow();
    expect(interrupt).not.toThrow();
    const call = { trait: 'notes', method: 'watch' };
    expect(issues).toEqual([
      { kind: 'post_failed', error: broken, call },
      { kind: 'post_failed', error: broken, call },
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
      opener.subscribe(notes.watch, 'from the top', listeners);
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
    accepter.handleSubscription(notes.watch, () => {
      const stop = stops[started] ?? (() => undefined);
      started += 1;
      return stop;
    });
    opener.connect();
    opener.subscribe(notes.watch, 'a', watcher());
    opener.subscribe(notes.watch, 'b', watcher());
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
    peer.call(notes.watch, 5, { tag: 'start', value: 'first' });
    await timers.advance(0);

    // When
    peer.call(notes.watch, 5, { tag: 'start', value: 'second' });
    peer.call(echo.listen, 5, { tag: 'stop', value: undefined });
    await timers.advance(0);

    // Then
    expect(starts).toEqual(['first']);
    expect(stops).toEqual([0]);
    const refused = { kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error };
    expect(issues).toEqual([refused, refused]);
    expect(peer.names()).toEqual(['accept']);
  });

  it('As a serving side, I hear that a disposed peer left once its last stop and its last call are done', async () => {
    // Given a peer with two subscriptions and a call this side still holds
    const onPeerIdle = vi.fn();
    const { opener, accepter, timers } = rig({ onPeerIdle });
    serveWatch(accepter);
    const held = deferred<ResultPayload<undefined, CallError<undefined>>>();
    accepter.handleRequest(notes.touch, () => held.promise);
    opener.connect();
    opener.subscribe(notes.watch, 'status', watcher());
    opener.subscribe(notes.watch, 'tick', watcher());
    void outcomeOf(opener.request(notes.touch, undefined));
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
      opener.subscribe(notes.watch, 'tick', listeners);
    }
    await timers.advance(0);

    // When this side ends both
    for (const sink of sinks) {
      sink.interrupt(ok());
    }
    await timers.advance(0);

    // Then the peer heard both ends and is not taken for gone
    for (const listeners of heard) {
      expect(listeners.ends).toEqual([ok()]);
    }
    expect(onPeerIdle).not.toHaveBeenCalled();

    // When it subscribes again and leaves that one
    const again = opener.subscribe(notes.watch, 'tick', watcher());
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
    peer.call(notes.watch, 1, { tag: 'start', value: 'status' });
    peer.call(notes.watch, 3, { tag: 'start', value: 'read' });
    await timers.advance(0);

    // When the peer stops its status, the read ends here, and then the peer's stop for the read arrives
    peer.call(notes.watch, 1, { tag: 'stop', value: undefined });
    await timers.advance(0);
    must(sinks[1], 'the read').interrupt(ok());
    peer.call(notes.watch, 3, { tag: 'stop', value: undefined });
    await timers.advance(0);

    // Then the peer is gone, once
    expect(onPeerIdle).toHaveBeenCalledOnce();
  });

  it('As a serving side, I keep a peer that left its last subscription with a call held and goes on making calls', async () => {
    // Given a peer whose last subscription it leaves while a call is held
    const onPeerIdle = vi.fn();
    const { opener, accepter, timers } = rig({ onPeerIdle });
    serveWatch(accepter);
    const held = deferred<ResultPayload<undefined, CallError<undefined>>>();
    accepter.handleRequest(notes.touch, () => held.promise);
    accepter.handleRequest(echo.say, text => ok(text));
    opener.connect();
    const ticks = opener.subscribe(notes.watch, 'tick', watcher());
    const touched = opener.request(notes.touch, undefined);
    await timers.advance(0);
    ticks.stop();
    await timers.advance(0);

    // When it makes another call, and both settle
    await opener.request(echo.say, 'still here');
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
    const held = deferred<ResultPayload<undefined, CallError<undefined>>>();
    transport.handleRequest(notes.touch, () => held.promise);
    peer.call(notes.watch, 1, { tag: 'start', value: 'tick' });
    await timers.advance(0);

    // When the peer leaves
    peer.call(notes.watch, 1, { tag: 'stop', value: undefined });
    await timers.advance(0);

    // Then
    expect(onPeerIdle).toHaveBeenCalledOnce();
    expect(issues).toEqual([{ kind: 'listener_threw', error: bug }]);

    // When it calls, starts and leaves again, and this side is disposed before its call settles
    peer.call(notes.touch, 3, { tag: 'request', value: undefined });
    peer.call(notes.watch, 5, { tag: 'start', value: 'tick' });
    peer.call(notes.watch, 5, { tag: 'stop', value: undefined });
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
    accepter.handleSubscription(notes.watch, (_start, _context, sink) => {
      sinks.push(sink);
      return () => {
        accepter.dispose(new Error('done here'));
      };
    });
    opener.connect();
    const ended = watcher();
    const other = watcher();
    opener.subscribe(notes.watch, 'a', ended);
    opener.subscribe(notes.watch, 'b', other);
    await timers.advance(0);

    // When
    must(sinks[0], 'the first sink').interrupt(err(domain('finished')));
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
    peer.call(notes.watch, 1, { tag: 'start', value: 'status' });
    peer.call(notes.watch, 3, { tag: 'start', value: 'read' });
    await timers.advance(0);

    // When this side ends the read, and the peer's stops for both arrive after
    must(sinks[1], 'the read').interrupt(ok());
    peer.call(notes.watch, 1, { tag: 'stop', value: undefined });
    peer.call(notes.watch, 3, { tag: 'stop', value: undefined });
    await timers.advance(0);

    // Then
    expect(onPeerIdle).toHaveBeenCalledOnce();

    // When it starts and leaves again
    peer.call(notes.watch, 5, { tag: 'start', value: 'tick' });
    peer.call(notes.watch, 5, { tag: 'stop', value: undefined });
    await timers.advance(0);

    // Then
    expect(onPeerIdle).toHaveBeenCalledTimes(2);
  });

  it('As a serving side, a stop before the handshake or for a subscription that is not running is refused as invalid, and I hear no peer leave', async () => {
    // Given
    const onPeerIdle = vi.fn();
    const { transport, timers, peer, issues, openHandshake } = rawRig('accept', undefined, { onPeerIdle });
    serveWatch(transport);

    // When a stop comes before the handshake, then one names an id never started
    peer.call(notes.watch, 1, { tag: 'stop', value: undefined });
    await timers.advance(0);
    openHandshake();
    await timers.advance(0);
    peer.call(notes.watch, 3, { tag: 'stop', value: undefined });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'invalid',
        cause: expect.objectContaining({ message: 'A call came before the handshake' }) as Error,
      },
      {
        kind: 'refused',
        reason: 'invalid',
        cause: expect.objectContaining({ message: 'A stop names subscription 3, which is not running' }) as Error,
      },
    ]);
    expect(onPeerIdle).not.toHaveBeenCalled();
    expect(peer.names()).toEqual(['accept']);
  });

  it('As a serving side, a call that does not decode or names an address I lack still keeps the peer', async () => {
    // Given a peer that leaves its last subscription while a call is held
    const onPeerIdle = vi.fn();
    const { transport, timers, peer } = await acceptedRaw(undefined, { onPeerIdle });
    serveWatch(transport);
    const releases: (() => void)[] = [];
    transport.handleRequest(
      notes.touch,
      () =>
        new Promise<ResultPayload<undefined, CallError<undefined>>>(resolve => {
          releases.push(() => {
            resolve(ok());
          });
        }),
    );
    const leaveWithCallHeld = async (id: number): Promise<void> => {
      peer.call(notes.touch, id, { tag: 'request', value: undefined });
      peer.call(notes.watch, id + 2, { tag: 'start', value: 'tick' });
      peer.call(notes.watch, id + 2, { tag: 'stop', value: undefined });
      await timers.advance(0);
    };
    await leaveWithCallHeld(1);

    // When it makes a call whose payload is cut short, and the held call settles
    peer.call(rawRead, 5, { tag: 'request', value: CUT_SHORT_TEXT }, notes.read);
    await timers.advance(0);
    releases[0]?.();
    await timers.advance(0);

    // Then
    expect(onPeerIdle).not.toHaveBeenCalled();

    // When it leaves again and then calls a method this schema lacks
    await leaveWithCallHeld(7);
    peer.send(11, { tag: 'call', value: { trait: NOTES, method: 7, message: Uint8Array.of(0, 1, 2) } });
    await timers.advance(0);
    releases[1]?.();
    await timers.advance(0);

    // Then
    expect(onPeerIdle).not.toHaveBeenCalled();
  });
});
