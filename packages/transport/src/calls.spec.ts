// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { must } from '@dotli/shared/testing';
import { TransportHandshakeTimeoutError } from './errors.js';
import { cancelled, domain, err, hostFailure, malformedFrame, ok, unsupported } from './result.js';
import {
  ECHO,
  LISTEN,
  NOTES,
  READ,
  TIMEOUT_MS,
  WATCH,
  breakable,
  outcomeOf,
  rawRig,
  rig,
  serveWatch,
  watcher,
} from './testing/rig.js';

/** The ids of the subscriptions a raw peer heard start, in order. */
const startIds = (peer: { find: (leg: string) => { id: number }[] }): number[] =>
  peer.find('start:notes.watch').map(message => message.id);

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

  it('As a caller, my calls and subscriptions go out in call order across the handshake', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = rawRig('open');
    // Registered first, so it hears the handshake end before any queued call does.
    const connected = transport.whenConnected().then(() => {
      transport.subscribe('notes', 'watch', 'once connected', watcher());
    });
    void transport.request('notes', 'touch', undefined);
    transport.subscribe('notes', 'watch', 'while connecting', watcher());
    transport.connect();
    await timers.advance(0);
    void transport.request('echo', 'say', 'after connect');

    // When
    answerHandshake();
    transport.subscribe('notes', 'watch', 'as the answer arrives', watcher());
    await connected;
    await timers.advance(0);

    // Then
    expect(peer.legs()).toEqual([
      'request:255.0',
      'request:notes.touch',
      'start:notes.watch',
      'request:echo.say',
      'start:notes.watch',
      'start:notes.watch',
    ]);
    expect(peer.find('start:notes.watch').map(message => message.body)).toEqual([
      'while connecting',
      'as the answer arrives',
      'once connected',
    ]);
  });

  it('As a subscriber, I hear values, then one interrupt', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const { sinks } = serveWatch(accepter);
    opener.connect();
    const clean = watcher();
    const failed = watcher();
    opener.subscribe('notes', 'watch', 'a', clean);
    opener.subscribe('notes', 'watch', 'b', failed);
    await timers.advance(0);
    const first = must(sinks[0], 'the first sink');
    const second = must(sinks[1], 'the second sink');

    // When
    first.receive('one');
    first.receive('two');
    first.interrupt();
    first.interrupt(domain('twice'));
    first.receive('late');
    second.interrupt(domain('no such note'));
    second.interrupt();
    await timers.advance(0);

    // Then
    expect(clean.values).toEqual(['one', 'two']);
    expect(clean.ends).toEqual([ok()]);
    expect(failed.values).toEqual([]);
    expect(failed.ends).toEqual([err(domain('no such note'))]);
    expect(issues).toEqual([]);
  });

  it('As a subscriber, stopping while queued sends nothing and I hear nothing', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = rawRig('open');
    const heard = watcher();
    const closes: Error[] = [];
    const handle = transport.subscribe('notes', 'watch', 'from the top', heard);
    handle.onClose(error => closes.push(error));
    transport.connect();
    await timers.advance(0);

    // When
    handle.stop();
    answerHandshake();
    await transport.whenConnected();
    await timers.advance(0);
    transport.dispose(new Error('done'));

    // Then
    expect(peer.legs()).toEqual(['request:255.0']);
    expect(heard.ends).toEqual([]);
    expect(closes).toEqual([]);
  });

  it('As a subscriber, stopping my open subscription posts one stop and I hear nothing more, a crossing interrupt included', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const heard = watcher();
    const handle = transport.subscribe('notes', 'watch', 'from the top', heard);
    await timers.advance(0);
    const [id = 0] = startIds(peer);

    // When
    handle.stop();
    handle.stop();
    peer.send({ kind: 'method', leg: 'receive', id, trait: NOTES, method: WATCH, payload: 'crossing' });
    peer.send({ kind: 'method', leg: 'interrupt', id, trait: NOTES, method: WATCH, outcome: ok() });
    await timers.advance(0);

    // Then
    expect(peer.find('stop:notes.watch').map(message => message.id)).toEqual([id]);
    expect(heard.values).toEqual([]);
    expect(heard.ends).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('As a caller, aborting my subscription posts stop and I hear Cancelled once', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const heard = watcher();
    const abort = new AbortController();
    const handle = transport.subscribe('notes', 'watch', 'from the top', heard, { signal: abort.signal });
    await timers.advance(0);
    const [id = 0] = startIds(peer);

    // When
    abort.abort();
    handle.stop();
    peer.send({ kind: 'method', leg: 'receive', id, trait: NOTES, method: WATCH, payload: 'crossing' });
    await timers.advance(0);

    // Then
    expect(heard.ends).toEqual([err(cancelled())]);
    expect(heard.values).toEqual([]);
    expect(peer.find('stop:notes.watch').map(message => message.id)).toEqual([id]);
    expect(issues).toEqual([]);
  });

  it('As a caller, a subscription aborted while queued or before it is made posts nothing and I hear Cancelled once', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = rawRig('open');
    const queued = watcher();
    const early = watcher();
    const abort = new AbortController();
    transport.subscribe('notes', 'watch', 'queued', queued, { signal: abort.signal });

    // When
    transport.subscribe('notes', 'watch', 'early', early, { signal: AbortSignal.abort() });

    // Then it hears nothing before the call returns
    expect(early.ends).toEqual([]);

    // When
    transport.connect();
    await timers.advance(0);
    abort.abort();
    answerHandshake();
    await transport.whenConnected();
    await timers.advance(0);

    // Then
    expect(queued.ends).toEqual([err(cancelled())]);
    expect(early.ends).toEqual([err(cancelled())]);
    expect(peer.legs()).toEqual(['request:255.0']);
  });

  it('As a caller, a transport that closes calls my onClose once with its error', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const { stops } = serveWatch(accepter);
    opener.connect();
    const heard = watcher();
    const handle = opener.subscribe('notes', 'watch', 'open', heard);
    const closes: Error[] = [];
    handle.onClose(error => closes.push(error));
    handle.onClose(error => closes.push(error));
    const stopped = opener.subscribe('notes', 'watch', 'stopped', watcher());
    const stoppedCloses: Error[] = [];
    stopped.onClose(error => stoppedCloses.push(error));
    await timers.advance(0);
    stopped.stop();
    const reason = new Error('the page is closing');

    // When
    opener.dispose(reason);
    opener.dispose(new Error('again'));
    await timers.advance(0);

    // Then
    expect(closes).toEqual([reason, reason]);
    expect(stoppedCloses).toEqual([]);
    expect(heard.ends).toEqual([]);
    expect(stops).toEqual([1, 1]);

    // When a listener comes late, and a subscription is made once closed
    const late: Error[] = [];
    handle.onClose(error => late.push(error));
    const after = opener.subscribe('notes', 'watch', 'after', watcher());
    after.onClose(error => late.push(error));
    after.stop();
    after.onClose(error => late.push(error));

    // Then
    expect(late).toEqual([reason, reason, reason]);
    expect(stops).toEqual([1, 1]);
    expect(issues).toEqual([]);
  });

  it('As a caller, a handshake that times out calls onClose of my queued subscription with why and posts no start', async () => {
    // Given
    const { transport, timers, peer } = rawRig('open');
    const heard = watcher();
    const closes: Error[] = [];
    transport.subscribe('notes', 'watch', 'queued', heard).onClose(error => closes.push(error));

    // When
    transport.connect();
    await timers.advance(TIMEOUT_MS);

    // Then
    expect(closes).toEqual([expect.any(TransportHandshakeTimeoutError)]);
    expect(heard.ends).toEqual([]);
    expect(peer.find('start:notes.watch')).toEqual([]);
  });

  it('As a subscriber, a listener that throws is reported as listener_threw and does not stop the others', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const { sinks } = serveWatch(accepter);
    opener.connect();
    const bug = new Error('listener bug');
    const throwing = {
      receive: vi.fn(() => {
        throw bug;
      }),
      interrupt: vi.fn(() => {
        throw bug;
      }),
    };
    const heard = watcher();
    opener.subscribe('notes', 'watch', 'a', throwing);
    opener.subscribe('notes', 'watch', 'b', heard);
    const closing = opener.subscribe('notes', 'watch', 'c', watcher());
    const closeBug = new Error('close listener bug');
    const closes = vi.fn();
    closing.onClose(() => {
      throw closeBug;
    });
    closing.onClose(closes);
    await timers.advance(0);

    // When
    for (const sink of sinks) {
      sink.receive('one');
      sink.receive('two');
    }
    must(sinks[0], 'the first sink').interrupt();
    must(sinks[1], 'the second sink').interrupt();
    await timers.advance(0);
    opener.dispose(new Error('done'));

    // Then
    expect(throwing.receive).toHaveBeenCalledTimes(2);
    expect(throwing.interrupt).toHaveBeenCalledOnce();
    expect(heard.values).toEqual(['one', 'two']);
    expect(heard.ends).toEqual([ok()]);
    expect(closes).toHaveBeenCalledOnce();
    expect(issues).toEqual([
      { kind: 'listener_threw', error: bug },
      { kind: 'listener_threw', error: bug },
      { kind: 'listener_threw', error: bug },
      { kind: 'listener_threw', error: closeBug },
    ]);
  });

  it('As a subscriber, I can stop and dispose from inside receive and onClose', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    const { sinks, stops } = serveWatch(accepter);
    opener.connect();
    const reason = new Error('torn down');
    const heardBySelfStopping = vi.fn();
    const selfStopping = opener.subscribe('notes', 'watch', 'a', {
      receive: () => {
        heardBySelfStopping();
        selfStopping.stop();
        selfStopping.stop();
      },
      interrupt: () => undefined,
    });
    const disposing = opener.subscribe('notes', 'watch', 'b', {
      receive: () => {
        opener.dispose(reason);
      },
      interrupt: () => undefined,
    });
    const disposingCloses = vi.fn();
    disposing.onClose(disposingCloses);
    const watcherCloses = vi.fn();
    let callFromClose: Promise<unknown> | undefined;
    const watched = opener.subscribe('notes', 'watch', 'c', watcher());
    watched.onClose(error => {
      watcherCloses(error);
      watched.stop();
      opener.dispose(new Error('second dispose'));
      callFromClose = outcomeOf(opener.request('echo', 'say', 'still there?'));
    });
    await timers.advance(0);

    // When
    must(sinks[0], 'the first sink').receive('one');
    must(sinks[0], 'the first sink').receive('two');
    await timers.advance(0);
    must(sinks[1], 'the second sink').receive('one');
    await timers.advance(0);

    // Then
    expect(heardBySelfStopping).toHaveBeenCalledOnce();
    expect(disposingCloses).toHaveBeenCalledExactlyOnceWith(reason);
    expect(watcherCloses).toHaveBeenCalledExactlyOnceWith(reason);
    expect(await callFromClose).toBe(reason);
    expect(stops).toEqual([1, 1, 1]);
  });

  it('As a subscriber, disposing from inside interrupt tells the peer only about what is still open', async () => {
    // Given
    const { transport, timers, peer } = await connectedRaw();
    transport.subscribe('notes', 'watch', 'ended', {
      receive: () => undefined,
      interrupt: () => {
        transport.dispose(new Error('torn down'));
      },
    });
    transport.subscribe('notes', 'watch', 'open', watcher());
    await timers.advance(0);
    const [ended = 0, open = 0] = startIds(peer);

    // When
    peer.send({ kind: 'method', leg: 'interrupt', id: ended, trait: NOTES, method: WATCH, outcome: ok() });
    await timers.advance(0);

    // Then
    expect(peer.find('stop:notes.watch').map(message => message.id)).toEqual([open]);
  });

  it('As a caller, a message on a subscription I stopped is dropped quietly, and one that cannot be a race is refused as invalid', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const stopped = watcher();
    const interrupted = watcher();
    const open = watcher();
    transport.subscribe('notes', 'watch', 'stopped', stopped).stop();
    await timers.advance(0);
    transport.subscribe('notes', 'watch', 'interrupted', interrupted);
    transport.subscribe('notes', 'watch', 'open', open);
    await timers.advance(0);
    const [ended = 0, running = 0] = startIds(peer);
    peer.send({ kind: 'method', leg: 'interrupt', id: ended, trait: NOTES, method: WATCH, outcome: ok() });
    await timers.advance(0);
    const handle = transport.subscribe('notes', 'watch', 'later', watcher());
    await timers.advance(0);
    const [, , later = 0] = startIds(peer);
    handle.stop();

    // When values and ends come on the stopped one, after the interrupt, under another method, and on an id never used
    peer.send({ kind: 'method', leg: 'receive', id: later, trait: NOTES, method: WATCH, payload: 'crossing' });
    peer.send({ kind: 'method', leg: 'interrupt', id: later, trait: NOTES, method: WATCH, outcome: ok() });
    peer.send({ kind: 'method', leg: 'receive', id: ended, trait: NOTES, method: WATCH, payload: 'after the end' });
    peer.send({ kind: 'method', leg: 'interrupt', id: ended, trait: NOTES, method: WATCH, outcome: ok() });
    peer.send({ kind: 'method', leg: 'receive', id: running, trait: ECHO, method: LISTEN, payload: 'elsewhere' });
    peer.send({ kind: 'method', leg: 'receive', id: 900, trait: NOTES, method: WATCH, payload: 'never asked' });
    await timers.advance(0);

    // Then
    expect(stopped.ends).toEqual([]);
    expect(interrupted.values).toEqual([]);
    expect(interrupted.ends).toEqual([ok()]);
    expect(open.values).toEqual([]);
    expect(open.ends).toEqual([]);
    const refused = { kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error };
    expect(issues).toEqual([refused, refused, refused, refused]);
  });

  it('As a caller, an interrupt or a value that does not decode ends my subscription as MalformedFrame, and is reported', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const first = watcher();
    const second = watcher();
    transport.subscribe('notes', 'watch', 'a', first);
    transport.subscribe('notes', 'watch', 'b', second);
    await timers.advance(0);
    const [a = 0, b = 0] = startIds(peer);

    // When an interrupt carries a domain error that is no UTF-8, and a value is no UTF-8
    peer.sendBytes(a, 0, 0, 0, NOTES, WATCH, 4, 1, 0, 0xff);
    peer.sendBytes(b, 0, 0, 0, NOTES, WATCH, 3, 0xff);
    await timers.advance(0);

    // Then the one whose value was lost is stopped
    const malformed = err(malformedFrame('The encoded data was not valid for encoding utf-8'));
    expect(first.ends).toEqual([malformed]);
    expect(second.ends).toEqual([malformed]);
    expect(peer.find('stop:notes.watch').map(message => message.id)).toEqual([b]);
    const refused = { kind: 'refused', reason: 'malformed', cause: expect.any(TypeError) as TypeError };
    expect(issues).toEqual([refused, refused]);
  });

  it('As a caller, a subscription the peer answers on the protocol error address ends as Unsupported', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const heard = watcher();
    transport.subscribe('notes', 'watch', 'from the top', heard);
    await timers.advance(0);
    const [id = 0] = startIds(peer);

    // When
    peer.send({ kind: 'protocolError', id, unsupportedMessage: { trait: NOTES, method: WATCH } });
    await timers.advance(0);

    // Then
    expect(heard.ends).toEqual([err(unsupported())]);
    expect(peer.find('stop:notes.watch')).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('As a caller, a start that does not encode throws and posts nothing', async () => {
    // Given
    const { transport, timers, peer } = await connectedRaw();

    // When
    const subscribe = (): void => {
      transport.subscribe('notes', 'watch', '', watcher());
    };

    // Then
    expect(subscribe).toThrow(new RangeError('A word is never empty'));
    await timers.advance(0);
    expect(peer.legs()).toEqual(['request:255.0']);
  });

  it('As a caller, a start my provider cannot post ends my subscription as HostFailure with why, and the post is reported', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts } = breakable(broken);
    const { transport, timers, issues } = await connectedRaw(wrap);
    breakPosts();
    const heard = watcher();

    // When
    transport.subscribe('notes', 'watch', 'from the top', heard);
    await timers.advance(0);

    // Then
    expect(heard.ends).toEqual([err(hostFailure('The start could not be posted, Error: the peer window is gone'))]);
    expect(issues).toEqual([{ kind: 'post_failed', leg: 'start', error: broken }]);
  });
});
