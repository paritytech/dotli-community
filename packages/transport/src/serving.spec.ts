// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { deferred, manualTimers } from '@dotli/shared/testing';
import { createProviderPair } from './provider.fake.js';
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
import { NOTES, READ, TOUCH, VERSION, WATCH, breakable, rawRig, rig, testSchema } from './testing/rig.js';
import { createTransport } from './transport.js';

/** A transport that accepted a raw peer's handshake. */
async function acceptedRaw(wrap?: Parameters<typeof rawRig>[1]) {
  const raw = rawRig('accept', wrap);
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

    // When
    const second = () => accepter.handleRequest('notes', 'read', () => ok('b'));

    // Then
    expect(second).toThrow('notes.read already has a handler');
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

  it('As a serving side, a subscription start is answered Unsupported until subscriptions are served', async () => {
    // Given
    const { timers, peer } = await acceptedRaw();

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
});
