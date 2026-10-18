// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { must } from '@dotli/shared/testing';
import { TransportHandshakeTimeoutError, type TransportIssue } from './errors.js';
import { cancelled, domain, err, malformedFrame, ok, unsupported } from './result.js';
import {
  breakable,
  echo,
  notes,
  outcomeOf,
  rawRig,
  rig,
  serveWatch,
  TIMEOUT_MS,
  watcher,
  CUT_SHORT_TEXT,
  rawRead,
  rawWatch,
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
    accepter.handleRequest(notes.read, key => {
      seen.push(key);
      return ok(key);
    });
    const read = (key: string) => opener.request(notes.read, key);
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
      void transport.request(echo.say, 'once connected');
    });
    void transport.request(notes.touch, undefined);
    transport.connect();
    await timers.advance(0);
    void transport.request(echo.say, 'while connecting');

    // When
    answerHandshake();
    void transport.request(notes.read, 'as the answer arrives');
    await connected;
    await timers.advance(0);

    // Then
    expect(peer.names()).toEqual([
      'open',
      'request:notes.touch',
      'request:echo.say',
      'request:notes.read',
      'request:echo.say',
    ]);
    expect(peer.values(echo.say, 'request:echo.say')).toEqual(['while connecting', 'once connected']);
  });

  it("As a caller, my call resolves to the handler's Result, a domain error included", async () => {
    // Given
    const { opener, accepter, timers } = rig();
    accepter.handleRequest(notes.read, key => (key === 'missing' ? err(domain('no such note')) : ok(`a ${key}`)));
    opener.connect();
    const { signal } = new AbortController();
    const detach = vi.spyOn(signal, 'removeEventListener');

    // When
    const found = opener.request(notes.read, 'note', { signal });
    const missing = opener.request(notes.read, 'missing');
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
    const call = opener.request(notes.touch, undefined);
    await timers.advance(0);

    // Then
    expect(await call).toEqual(err(unsupported()));
  });

  it('As a caller, a call the peer fails as Unsupported resolves Unsupported', async () => {
    // Given
    const { transport, timers, peer } = await connectedRaw();
    const call = transport.request(notes.read, 'note');
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');

    // When
    peer.send(asked.id, { tag: 'failed', value: unsupported() });
    await timers.advance(0);

    // Then
    expect(await call).toEqual(err(unsupported()));
  });

  it('As a caller, an answer that names another method than my call is refused as invalid and my call waits on', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const call = transport.request(notes.read, 'note');
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');

    // When
    peer.call(notes.touch, asked.id, { tag: 'response', value: ok() });
    await timers.advance(0);
    peer.call(notes.read, asked.id, { tag: 'response', value: ok('the note') });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error }]);
    expect(await call).toEqual(ok('the note'));
  });

  it('As a caller, aborting my open call resolves Cancelled and a late answer is ignored', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const giveUp = new AbortController();
    const detach = vi.spyOn(giveUp.signal, 'removeEventListener');
    const call = transport.request(notes.read, 'note', { signal: giveUp.signal });
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');

    // When
    giveUp.abort(new Error('the budget ran out'));
    peer.call(notes.read, asked.id, { tag: 'response', value: ok('late') });
    peer.call(notes.read, asked.id, { tag: 'response', value: ok('late') });
    await timers.advance(0);

    // Then
    expect(await call).toEqual(err(cancelled()));
    expect(issues).toEqual([]);
    expect(peer.names()).toEqual(['open', 'request:notes.read']);
    expect(detach).toHaveBeenCalledOnce();
    // A call still waiting would be settled again by the dispose, and detach its listener a second time.
    transport.dispose(new Error('done'));
    expect(detach).toHaveBeenCalledOnce();
  });

  it('As a caller, a call aborted while queued settles once as Cancelled and never posts, even when the handshake then fails', async () => {
    // Given
    const { transport, timers, peer } = rawRig('open');
    const giveUp = new AbortController();
    const call = outcomeOf(transport.request(notes.touch, undefined, { signal: giveUp.signal }));
    transport.connect();
    await timers.advance(0);

    // When
    giveUp.abort();
    await timers.advance(TIMEOUT_MS);

    // Then
    expect(await outcomeOf(transport.whenConnected())).toBeInstanceOf(TransportHandshakeTimeoutError);
    expect(await call).toEqual({ value: err(cancelled()) });
    expect(new Set(peer.names())).toEqual(new Set(['open']));
  });

  it('As a caller, a call aborted while queued never goes out once the handshake succeeds', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = rawRig('open');
    const giveUp = new AbortController();
    const call = transport.request(notes.touch, undefined, { signal: giveUp.signal });
    transport.connect();
    await timers.advance(0);

    // When
    giveUp.abort();
    answerHandshake();
    await transport.whenConnected();
    await timers.advance(0);

    // Then
    expect(await call).toEqual(err(cancelled()));
    expect(peer.names()).toEqual(['open']);
  });

  it('As a caller, a call with an already aborted signal resolves Cancelled at once and posts nothing', async () => {
    // Given
    const { transport, timers, peer } = await connectedRaw();

    // When
    const call = transport.request(notes.touch, undefined, { signal: AbortSignal.abort() });

    // Then a marker settled after the call loses the race, so the call settled before any queue step
    expect(await Promise.race([call, Promise.resolve('still waiting')])).toEqual(err(cancelled()));
    await timers.advance(0);
    expect(peer.names()).toEqual(['open']);
  });

  it('As a caller, an answer that does not decode resolves my call as MalformedFrame and is reported', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const call = transport.request(notes.read, 'note');
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');

    // When an Ok answer to the call carries text that is cut short
    peer.call(rawRead, asked.id, { tag: 'response', value: ok(CUT_SHORT_TEXT) }, notes.read);
    await timers.advance(0);

    // Then
    expect(await call).toEqual(err(malformedFrame('RangeError: Invalid DataView length 2')));
    expect(issues).toEqual([{ kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError }]);
  });

  it('As a caller, a payload that cannot be encoded rejects my call and posts nothing', async () => {
    // Given
    const { opener, accepter, timers, delivered } = rig();
    accepter.handleRequest(notes.touch, () => ok());
    const queuedBad = outcomeOf(opener.request(notes.read, ''));
    const queuedGood = opener.request(notes.touch, undefined);
    opener.connect();
    await timers.advance(0);
    expect(await queuedBad).toBeInstanceOf(RangeError);
    expect(await queuedGood).toEqual(ok());
    const posted = delivered.length;

    // When
    const bad = outcomeOf(opener.request(notes.read, ''));
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
    const call = outcomeOf(transport.request(notes.touch, undefined));
    await timers.advance(0);

    // Then
    expect(await call).toMatchObject({ message: 'The request could not be posted', cause: broken });
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { trait: 'notes', method: 'touch' } }]);
  });

  it('As a caller, a closed transport rejects my pending and later requests with the closing error', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    accepter.handleRequest(notes.read, () => new Promise(() => undefined));
    opener.connect();
    const pending = outcomeOf(opener.request(notes.read, 'note'));
    await timers.advance(0);
    const reason = new Error('the page is closing');

    // When
    opener.dispose(reason);

    // Then
    expect(await pending).toBe(reason);
    expect(await outcomeOf(opener.request(notes.read, 'later'))).toBe(reason);
    expect(await outcomeOf(opener.request(notes.touch, undefined, { signal: AbortSignal.abort() }))).toBe(reason);
    expect(await outcomeOf(opener.whenConnected())).toBe(reason);
  });

  it('As a caller, my queued calls reject with the dispose reason and the handshake stops', async () => {
    // Given
    const { transport, timers, peer, left } = rawRig('open');
    transport.connect();
    const call = outcomeOf(transport.request(notes.touch, undefined));
    await timers.advance(100);
    expect(peer.names()).toEqual(['open', 'open', 'open']);
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
      transport.subscribe(notes.watch, 'once connected', watcher());
    });
    void transport.request(notes.touch, undefined);
    transport.subscribe(notes.watch, 'while connecting', watcher());
    transport.connect();
    await timers.advance(0);
    void transport.request(echo.say, 'after connect');

    // When
    answerHandshake();
    transport.subscribe(notes.watch, 'as the answer arrives', watcher());
    await connected;
    await timers.advance(0);

    // Then
    expect(peer.names()).toEqual([
      'open',
      'request:notes.touch',
      'start:notes.watch',
      'request:echo.say',
      'start:notes.watch',
      'start:notes.watch',
    ]);
    expect(peer.values(notes.watch, 'start:notes.watch')).toEqual([
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
    opener.subscribe(notes.watch, 'a', clean);
    opener.subscribe(notes.watch, 'b', failed);
    await timers.advance(0);
    const first = must(sinks[0], 'the first sink');
    const second = must(sinks[1], 'the second sink');

    // When
    first.receive('one');
    first.receive('two');
    first.interrupt(ok());
    first.interrupt(err(domain('twice')));
    first.receive('late');
    second.interrupt(err(domain('no such note')));
    second.interrupt(ok());
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
    const stop = transport.subscribe(notes.watch, 'from the top', heard);
    transport.connect();
    await timers.advance(0);

    // When
    stop();
    answerHandshake();
    await transport.whenConnected();
    await timers.advance(0);
    transport.dispose(new Error('done'));

    // Then
    expect(peer.names()).toEqual(['open']);
    expect(heard.ends).toEqual([]);
    expect(heard.closes).toEqual([]);
  });

  it('As a subscriber, stopping my open subscription posts one stop and I hear nothing more, a crossing interrupt included', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const heard = watcher();
    const stop = transport.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);
    const [id = 0] = startIds(peer);

    // When
    stop();
    stop();
    peer.call(notes.watch, id, { tag: 'receive', value: 'crossing' });
    peer.call(notes.watch, id, { tag: 'interrupt', value: ok() });
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
    const stop = transport.subscribe(notes.watch, 'from the top', heard, { signal: abort.signal });
    await timers.advance(0);
    const [id = 0] = startIds(peer);

    // When
    abort.abort();
    stop();
    peer.call(notes.watch, id, { tag: 'receive', value: 'crossing' });
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
    transport.subscribe(notes.watch, 'queued', queued, { signal: abort.signal });

    // When
    transport.subscribe(notes.watch, 'early', early, { signal: AbortSignal.abort() });

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
    expect(peer.names()).toEqual(['open']);
  });

  it('As a caller, a transport that closes closes my subscription once with its error', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const { stops } = serveWatch(accepter);
    opener.connect();
    const heard = watcher();
    opener.subscribe(notes.watch, 'open', heard);
    const stopped = watcher();
    const stop = opener.subscribe(notes.watch, 'stopped', stopped);
    await timers.advance(0);
    stop();
    const reason = new Error('the page is closing');

    // When
    opener.dispose(reason);
    opener.dispose(new Error('again'));
    await timers.advance(0);

    // Then
    expect(heard.closes).toEqual([reason]);
    expect(stopped.closes).toEqual([]);
    expect(heard.ends).toEqual([]);
    expect(stops).toEqual([1, 1]);

    // When a subscription is made once closed, and stopped before it hears
    const after = watcher();
    opener.subscribe(notes.watch, 'after', after);
    const stoppedAfter = watcher();
    opener.subscribe(notes.watch, 'stopped after', stoppedAfter)();
    await timers.advance(0);

    // Then
    expect(after.closes).toEqual([reason]);
    expect(stoppedAfter.closes).toEqual([]);
    expect(stops).toEqual([1, 1]);
    expect(issues).toEqual([]);
  });

  it('As a caller, aborting or closing after the peer interrupted my subscription changes nothing', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const heard = watcher();
    const abort = new AbortController();
    transport.subscribe(notes.watch, 'from the top', heard, { signal: abort.signal });
    await timers.advance(0);
    const [id = 0] = startIds(peer);
    peer.call(notes.watch, id, { tag: 'interrupt', value: ok() });
    await timers.advance(0);

    // When
    abort.abort();
    transport.dispose(new Error('done'));
    await timers.advance(0);

    // Then
    expect(heard.ends).toEqual([ok()]);
    expect(heard.closes).toEqual([]);
    expect(peer.find('stop:notes.watch')).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('As a caller, disposing while my start is queued closes it with the reason and posts no start', async () => {
    // Given
    const { transport, timers, peer } = rawRig('open');
    const heard = watcher();
    transport.subscribe(notes.watch, 'queued', heard);
    transport.connect();
    await timers.advance(0);
    const reason = new Error('leaving');

    // When
    transport.dispose(reason);
    await timers.advance(0);

    // Then
    expect(heard.closes).toEqual([reason]);
    expect(heard.ends).toEqual([]);
    expect(peer.find('start:notes.watch')).toEqual([]);
  });

  it('As a caller, a handshake that times out closes my queued subscription with why and posts no start', async () => {
    // Given
    const { transport, timers, peer } = rawRig('open');
    const heard = watcher();
    transport.subscribe(notes.watch, 'queued', heard);

    // When
    transport.connect();
    await timers.advance(TIMEOUT_MS);

    // Then
    expect(heard.closes).toEqual([expect.any(TransportHandshakeTimeoutError)]);
    expect(heard.ends).toEqual([]);
    expect(peer.find('start:notes.watch')).toEqual([]);
  });

  it('As a subscriber, a listener that throws is reported as listener_threw and does not stop the others', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const { sinks } = serveWatch(accepter);
    opener.connect();
    const bug = new Error('listener bug');
    const closeBug = new Error('close listener bug');
    const throwing = {
      receive: vi.fn(() => {
        throw bug;
      }),
      interrupt: vi.fn(() => {
        throw bug;
      }),
      close: vi.fn(() => undefined),
    };
    const heard = watcher();
    opener.subscribe(notes.watch, 'a', throwing);
    opener.subscribe(notes.watch, 'b', heard);
    const closing = {
      ...watcher(),
      close: vi.fn(() => {
        throw closeBug;
      }),
    };
    opener.subscribe(notes.watch, 'c', closing);
    const closed = watcher();
    opener.subscribe(notes.watch, 'd', closed);
    await timers.advance(0);

    // When
    for (const sink of sinks) {
      sink.receive('one');
      sink.receive('two');
    }
    must(sinks[0], 'the first sink').interrupt(ok());
    must(sinks[1], 'the second sink').interrupt(ok());
    await timers.advance(0);
    opener.dispose(new Error('done'));

    // Then
    expect(throwing.receive).toHaveBeenCalledTimes(2);
    expect(throwing.interrupt).toHaveBeenCalledOnce();
    expect(heard.values).toEqual(['one', 'two']);
    expect(heard.ends).toEqual([ok()]);
    expect(closing.close).toHaveBeenCalledOnce();
    expect(closed.closes).toHaveLength(1);
    expect(issues).toEqual([
      { kind: 'listener_threw', error: bug },
      { kind: 'listener_threw', error: bug },
      { kind: 'listener_threw', error: bug },
      { kind: 'listener_threw', error: closeBug },
    ]);
  });

  it('As a subscriber, I can stop and dispose from inside receive and close', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    const { sinks, stops } = serveWatch(accepter);
    opener.connect();
    const reason = new Error('torn down');
    const heardBySelfStopping = vi.fn();
    const stopSelf = opener.subscribe(notes.watch, 'a', {
      receive: () => {
        heardBySelfStopping();
        stopSelf();
        stopSelf();
      },
      interrupt: () => undefined,
      close: () => undefined,
    });
    const disposingCloses = vi.fn();
    opener.subscribe(notes.watch, 'b', {
      receive: () => {
        opener.dispose(reason);
      },
      interrupt: () => undefined,
      close: disposingCloses,
    });
    const watcherCloses = vi.fn();
    let callFromClose: Promise<unknown> | undefined;
    const stopWatched = opener.subscribe(notes.watch, 'c', {
      ...watcher(),
      close: error => {
        watcherCloses(error);
        stopWatched();
        opener.dispose(new Error('second dispose'));
        callFromClose = outcomeOf(opener.request(echo.say, 'still there?'));
      },
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
    transport.subscribe(notes.watch, 'ended', {
      receive: () => undefined,
      interrupt: () => {
        transport.dispose(new Error('torn down'));
      },
      close: () => undefined,
    });
    transport.subscribe(notes.watch, 'open', watcher());
    await timers.advance(0);
    const [ended = 0, open = 0] = startIds(peer);

    // When
    peer.call(notes.watch, ended, { tag: 'interrupt', value: ok() });
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
    const stopStopped = transport.subscribe(notes.watch, 'stopped', stopped);
    stopStopped();
    await timers.advance(0);
    transport.subscribe(notes.watch, 'interrupted', interrupted);
    transport.subscribe(notes.watch, 'open', open);
    await timers.advance(0);
    const [ended = 0, running = 0] = startIds(peer);
    peer.call(notes.watch, ended, { tag: 'interrupt', value: ok() });
    await timers.advance(0);
    const stopLater = transport.subscribe(notes.watch, 'later', watcher());
    await timers.advance(0);
    const [, , later = 0] = startIds(peer);
    stopLater();

    // When values and ends come on the stopped one, after the interrupt, under another method, and on an id never used
    peer.call(notes.watch, later, { tag: 'receive', value: 'crossing' });
    peer.call(notes.watch, later, { tag: 'interrupt', value: ok() });
    peer.call(notes.watch, ended, { tag: 'receive', value: 'after the end' });
    peer.call(notes.watch, ended, { tag: 'interrupt', value: ok() });
    peer.call(echo.listen, running, { tag: 'receive', value: 'elsewhere' });
    peer.call(notes.watch, 901, { tag: 'receive', value: 'never asked' });
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
    transport.subscribe(notes.watch, 'a', first);
    transport.subscribe(notes.watch, 'b', second);
    await timers.advance(0);
    const [a = 0, b = 0] = startIds(peer);

    // When an interrupt carries a domain error that is cut short, and a value is cut short
    peer.call(rawWatch, a, { tag: 'interrupt', value: err(domain(CUT_SHORT_TEXT)) }, notes.watch);
    peer.call(rawWatch, b, { tag: 'receive', value: CUT_SHORT_TEXT }, notes.watch);
    await timers.advance(0);

    // Then both end, and each is stopped, since what did not decode may have been a value
    const malformed = err(malformedFrame('RangeError: Invalid DataView length 2'));
    expect(first.ends).toEqual([malformed]);
    expect(second.ends).toEqual([malformed]);
    expect(peer.find('stop:notes.watch').map(message => message.id)).toEqual([a, b]);
    const refused = { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError };
    expect(issues).toEqual([refused, refused]);
  });

  it('As a caller, a subscription the peer fails as Unsupported ends as Unsupported', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const heard = watcher();
    transport.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);
    const [id = 0] = startIds(peer);

    // When
    peer.send(id, { tag: 'failed', value: unsupported() });
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
      transport.subscribe(notes.watch, '', watcher());
    };

    // Then
    expect(subscribe).toThrow(new RangeError('A word is never empty'));
    await timers.advance(0);
    expect(peer.names()).toEqual(['open']);
  });

  it('As a caller, an issue hook that disposes on my failed start post leaves the peer nothing to stop', async () => {
    // Given a hook that mends posts and disposes when the start cannot be posted
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = breakable(broken);
    const reason = new Error('leaving');
    const issues: TransportIssue[] = [];
    const raw = rawRig('open', wrap, {
      onIssue: issue => {
        issues.push(issue);
        if (issue.kind === 'post_failed') {
          mendPosts();
          raw.transport.dispose(reason);
        }
      },
    });
    raw.transport.connect();
    await raw.timers.advance(0);
    raw.answerHandshake();
    await raw.transport.whenConnected();
    breakPosts();
    const heard = watcher();

    // When
    raw.transport.subscribe(notes.watch, 'from the top', heard);
    await raw.timers.advance(0);

    // Then the transport closed it before the post returned, and the peer heard no stop
    expect(heard.closes).toEqual([reason]);
    expect(heard.ends).toEqual([]);
    expect(raw.peer.names()).toEqual(['open']);
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { trait: 'notes', method: 'watch' } }]);
  });

  it('As a caller, an issue hook that stops my subscription on its failed start post leaves the peer nothing to stop', async () => {
    // Given a hook that mends posts and stops the subscription when its start cannot be posted
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = breakable(broken);
    const issues: TransportIssue[] = [];
    // The stop is made after the hook, which runs only once the start is posted.
    const stops: (() => void)[] = [];
    const raw = rawRig('open', wrap, {
      onIssue: issue => {
        issues.push(issue);
        if (issue.kind === 'post_failed') {
          mendPosts();
          stops[0]?.();
        }
      },
    });
    raw.transport.connect();
    await raw.timers.advance(0);
    raw.answerHandshake();
    await raw.transport.whenConnected();
    breakPosts();
    const heard = watcher();

    // When
    stops.push(raw.transport.subscribe(notes.watch, 'from the top', heard));
    await raw.timers.advance(0);
    raw.transport.dispose(new Error('done'));
    await raw.timers.advance(0);

    // Then the stop ended it before the post returned, and the peer heard no stop
    expect(heard.closes).toEqual([]);
    expect(heard.ends).toEqual([]);
    expect(raw.peer.names()).toEqual(['open']);
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { trait: 'notes', method: 'watch' } }]);
  });

  it('As a caller, a start my provider cannot post closes my subscription with why, and the post is reported', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = breakable(broken);
    const { transport, timers, peer, issues } = await connectedRaw(wrap);
    breakPosts();
    const heard = watcher();

    // When
    const stop = transport.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);
    mendPosts();
    stop();
    transport.dispose(new Error('done'));
    await timers.advance(0);

    // Then
    const failed = expect.objectContaining({ message: 'The start could not be posted', cause: broken }) as Error;
    expect(heard.closes).toEqual([failed]);
    expect(heard.ends).toEqual([]);
    expect(peer.names()).toEqual(['open']);
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { trait: 'notes', method: 'watch' } }]);
  });
});
