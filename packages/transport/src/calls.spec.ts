// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { must } from '@dotli/shared/testing';
import { TransportHandshakeTimeoutError } from './errors.js';
import { cancelled, domain, err, malformedFrame, ok, unsupported } from './result.js';
import { NOTES, READ, TIMEOUT_MS, breakable, outcomeOf, rawRig, rig } from './testing/rig.js';

/** A transport that opened toward a raw peer, with the handshake answered. */
async function connectedRaw(wrap?: Parameters<typeof rawRig>[1]) {
  const raw = rawRig('open', wrap);
  raw.transport.connect();
  await raw.timers.advance(0);
  raw.answerHandshake();
  await raw.transport.whenConnected();
  return raw;
}

describe('calls', () => {
  it('As a caller, my calls queued before the handshake go out in call order', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    const seen: string[] = [];
    accepter.handleRequest('notes', 'read', key => {
      seen.push(key);
      return ok(key);
    });
    const read = (key: string) => opener.request('notes', 'read', key);
    const fourth = read('1').then(() => read('4'));
    const second = read('2');
    const third = read('3');

    // When
    opener.connect();
    await timers.advance(0);
    await Promise.all([fourth, second, third]);

    // Then
    expect(seen).toEqual(['1', '2', '3', '4']);
  });

  it('As a caller, my calls go out in call order across the handshake, and one made once connected goes behind them', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = rawRig('open');
    // Registered first, so it hears the handshake end before any queued call does.
    const connected = transport.whenConnected().then(() => {
      void transport.request('echo', 'say', 'once connected');
    });
    void transport.request('notes', 'touch', undefined);
    transport.connect();
    await timers.advance(0);
    void transport.request('echo', 'say', 'while connecting');

    // When
    answerHandshake();
    void transport.request('notes', 'read', 'as the answer arrives');
    await connected;
    await timers.advance(0);

    // Then
    expect(peer.legs()).toEqual([
      'request:255.0',
      'request:notes.touch',
      'request:echo.say',
      'request:notes.read',
      'request:echo.say',
    ]);
    expect(peer.find('request:echo.say').map(message => message.body)).toEqual(['while connecting', 'once connected']);
  });

  it("As a caller, my call resolves to the handler's Result, a domain error included", async () => {
    // Given
    const { opener, accepter, timers } = rig();
    accepter.handleRequest('notes', 'read', key => (key === 'missing' ? err(domain('no such note')) : ok(`a ${key}`)));
    opener.connect();
    const { signal } = new AbortController();
    const detach = vi.spyOn(signal, 'removeEventListener');

    // When
    const found = opener.request('notes', 'read', 'note', { signal });
    const missing = opener.request('notes', 'read', 'missing');
    await timers.advance(0);

    // Then
    expect(await found).toEqual(ok('a note'));
    expect(await missing).toEqual(err(domain('no such note')));
    expect(detach).toHaveBeenCalledOnce();
  });

  it('As a caller, a method the peer does not serve answers Unsupported', async () => {
    // Given
    const { opener, timers } = rig();
    opener.connect();

    // When
    const call = opener.request('notes', 'touch', undefined);
    await timers.advance(0);

    // Then
    expect(await call).toEqual(err(unsupported()));
  });

  it('As a caller, a call the peer answers on the protocol error address resolves Unsupported', async () => {
    // Given
    const { transport, timers, peer } = await connectedRaw();
    const call = transport.request('notes', 'read', 'note');
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');

    // When
    peer.send({ kind: 'protocolError', id: asked.id, unsupportedMessage: { trait: NOTES, method: READ } });
    await timers.advance(0);

    // Then
    expect(await call).toEqual(err(unsupported()));
  });

  it('As a caller, an answer that names another method than my call is refused as invalid and my call waits on', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const call = transport.request('notes', 'read', 'note');
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');
    const answer = { kind: 'method', leg: 'response', id: asked.id, trait: NOTES, method: READ } as const;

    // When
    peer.send({ ...answer, method: READ + 1, outcome: ok() });
    peer.send({ kind: 'protocolError', id: asked.id, unsupportedMessage: { trait: NOTES, method: READ + 1 } });
    await timers.advance(0);
    peer.send({ ...answer, outcome: ok('the note') });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      { kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error },
      { kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error },
    ]);
    expect(await call).toEqual(ok('the note'));
  });

  it('As a caller, aborting my open call resolves Cancelled and a late answer is ignored', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const giveUp = new AbortController();
    const detach = vi.spyOn(giveUp.signal, 'removeEventListener');
    const call = transport.request('notes', 'read', 'note', { signal: giveUp.signal });
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');

    // When
    giveUp.abort(new Error('the budget ran out'));
    const late = {
      kind: 'method',
      leg: 'response',
      id: asked.id,
      trait: NOTES,
      method: READ,
      outcome: ok('late'),
    } as const;
    peer.send(late);
    peer.send(late);
    await timers.advance(0);

    // Then
    expect(await call).toEqual(err(cancelled()));
    expect(issues).toEqual([]);
    expect(peer.legs()).toEqual(['request:255.0', 'request:notes.read']);
    expect(detach).toHaveBeenCalledOnce();
    // A call still waiting would be settled again by the dispose, and detach its listener a second time.
    transport.dispose(new Error('done'));
    expect(detach).toHaveBeenCalledOnce();
  });

  it('As a caller, a call aborted while queued settles once as Cancelled and never posts, even when the handshake then fails', async () => {
    // Given
    const { transport, timers, peer } = rawRig('open');
    const giveUp = new AbortController();
    const call = outcomeOf(transport.request('notes', 'touch', undefined, { signal: giveUp.signal }));
    transport.connect();
    await timers.advance(0);

    // When
    giveUp.abort();
    await timers.advance(TIMEOUT_MS);

    // Then
    expect(await outcomeOf(transport.whenConnected())).toBeInstanceOf(TransportHandshakeTimeoutError);
    expect(await call).toEqual({ value: err(cancelled()) });
    expect(new Set(peer.legs())).toEqual(new Set(['request:255.0']));
  });

  it('As a caller, a call aborted while queued never goes out once the handshake succeeds', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = rawRig('open');
    const giveUp = new AbortController();
    const call = transport.request('notes', 'touch', undefined, { signal: giveUp.signal });
    transport.connect();
    await timers.advance(0);

    // When
    giveUp.abort();
    answerHandshake();
    await transport.whenConnected();
    await timers.advance(0);

    // Then
    expect(await call).toEqual(err(cancelled()));
    expect(peer.legs()).toEqual(['request:255.0']);
  });

  it('As a caller, a call with an already aborted signal resolves Cancelled at once and posts nothing', async () => {
    // Given
    const { transport, timers, peer } = await connectedRaw();

    // When
    const call = transport.request('notes', 'touch', undefined, { signal: AbortSignal.abort() });

    // Then a marker settled after the call loses the race, so the call settled before any queue step
    expect(await Promise.race([call, Promise.resolve('still waiting')])).toEqual(err(cancelled()));
    await timers.advance(0);
    expect(peer.legs()).toEqual(['request:255.0']);
  });

  it('As a caller, an answer that does not decode resolves my call as MalformedFrame and is reported', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const call = transport.request('notes', 'read', 'note');
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');

    // When an Ok answer to the call carries text that is no UTF-8
    peer.sendBytes(asked.id, 0, 0, 0, NOTES, READ, 1, 0, 0xff);
    await timers.advance(0);

    // Then
    expect(await call).toEqual(err(malformedFrame('The encoded data was not valid for encoding utf-8')));
    expect(issues).toEqual([{ kind: 'refused', reason: 'malformed', cause: expect.any(TypeError) as TypeError }]);
  });

  it('As a caller, a payload that cannot be encoded rejects my call and posts nothing', async () => {
    // Given
    const { opener, accepter, timers, delivered } = rig();
    accepter.handleRequest('notes', 'touch', () => ok());
    const queuedBad = outcomeOf(opener.request('notes', 'read', ''));
    const queuedGood = opener.request('notes', 'touch', undefined);
    opener.connect();
    await timers.advance(0);
    expect(await queuedBad).toBeInstanceOf(RangeError);
    expect(await queuedGood).toEqual(ok());
    const posted = delivered.length;

    // When
    const bad = outcomeOf(opener.request('notes', 'read', ''));
    await timers.advance(0);

    // Then
    expect(await bad).toBeInstanceOf(RangeError);
    expect(delivered).toHaveLength(posted);
  });

  it('As a caller, a call my provider cannot post rejects with why, and the post is reported', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts } = breakable(broken);
    const { transport, timers, issues } = await connectedRaw(wrap);

    // When
    breakPosts();
    const call = outcomeOf(transport.request('notes', 'touch', undefined));
    await timers.advance(0);

    // Then
    expect(await call).toMatchObject({ message: 'The request could not be posted', cause: broken });
    expect(issues).toEqual([{ kind: 'post_failed', leg: 'request', error: broken }]);
  });

  it('As a caller, a closed transport rejects my pending and later requests with the closing error', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    accepter.handleRequest('notes', 'read', () => new Promise(() => undefined));
    opener.connect();
    const pending = outcomeOf(opener.request('notes', 'read', 'note'));
    await timers.advance(0);
    const reason = new Error('the page is closing');

    // When
    opener.dispose(reason);

    // Then
    expect(await pending).toBe(reason);
    expect(await outcomeOf(opener.request('notes', 'read', 'later'))).toBe(reason);
    expect(await outcomeOf(opener.request('notes', 'touch', undefined, { signal: AbortSignal.abort() }))).toBe(reason);
    expect(await outcomeOf(opener.whenConnected())).toBe(reason);
  });

  it('As a caller, my queued calls reject with the dispose reason and the handshake stops', async () => {
    // Given
    const { transport, timers, peer, left } = rawRig('open');
    transport.connect();
    const call = outcomeOf(transport.request('notes', 'touch', undefined));
    await timers.advance(100);
    expect(peer.legs()).toEqual(['request:255.0', 'request:255.0', 'request:255.0']);
    const post = vi.spyOn(left, 'post');
    const reason = new Error('the peer left');

    // When
    transport.dispose(reason);
    await timers.advance(1_000);

    // Then
    expect(await call).toBe(reason);
    expect(await outcomeOf(transport.whenConnected())).toBe(reason);
    expect(post).not.toHaveBeenCalled();
  });
});
