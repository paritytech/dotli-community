// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { type ResultPayload, str } from 'scale-ts';
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest';
import { deferred } from '@dotli/shared';
import { manualTimers, must, recordLog } from '@dotli/shared/testing';
import {
  TransportHandshakeTimeoutError,
  TransportVersionMismatchError,
  cancelled,
  domain,
  err,
  hostFailure,
  malformedFrame,
  ok,
  unsupported,
  type CallError,
  type TransportIssue,
} from './errors.js';
import { createProviderPair } from './provider.fake.js';
import type { Provider } from './provider.js';
import { codec, defineSchema } from './schema.js';
import {
  breakable,
  CUT_SHORT_TEXT,
  echo,
  issueLog,
  notes,
  NOTES,
  outcomeOf,
  rawRead,
  rawRig,
  rawWatch,
  RETRY_MS,
  rig,
  serveWatch,
  testSchema,
  TIMEOUT_MS,
  VERSION,
  watcher,
} from './testing/rig.js';
import { createTransport, type CallContext, type Sink, type Transport, type TransportOptions } from './transport.js';
import { encodeFrame, frame } from './wire.js';

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

/** A transport that accepted a raw peer's handshake. */
async function acceptedRaw(wrap?: Parameters<typeof rawRig>[1], watched?: Parameters<typeof rawRig>[2]) {
  const raw = rawRig('accept', wrap, watched);
  raw.openHandshake();
  await raw.timers.advance(0);
  return raw;
}

describe('createTransport', () => {
  it('As a schema author, my calls and handlers are typed by the method I pass', () => {
    // Given
    type Notes = Transport<string>;

    // When
    const typeOnly = (transport: Notes): void => {
      expectTypeOf(transport.request(notes.read, 'a note')).resolves.toEqualTypeOf<
        ResultPayload<string, CallError<string>>
      >();
      // @ts-expect-error a subscription is not a request
      void transport.request(notes.watch, 'from the top');
      // @ts-expect-error the payload is text
      void transport.request(echo.say, 1);
      const handle = transport.subscribe(notes.watch, 'from the top', {
        receive: value => {
          expectTypeOf(value).toEqualTypeOf<string>();
        },
        interrupt: outcome => {
          expectTypeOf(outcome).toEqualTypeOf<ResultPayload<undefined, CallError<string>>>();
        },
        close: error => {
          expectTypeOf(error).toEqualTypeOf<Error>();
        },
      });
      expectTypeOf(handle).toEqualTypeOf<() => void>();
      // @ts-expect-error a request is not a subscription
      transport.subscribe(notes.read, 'a note', watcher());
      // @ts-expect-error a subscription is not served as a request
      transport.handleRequest(notes.watch, () => ok());
      transport.handleRequest(notes.read, (payload, context) => {
        expectTypeOf(payload).toEqualTypeOf<string>();
        expectTypeOf(context).toEqualTypeOf<CallContext<string>>();
        return ok(payload);
      });
      transport.handleSubscription(echo.listen, (start, _context, sink) => {
        expectTypeOf(start).toEqualTypeOf<undefined>();
        expectTypeOf(sink).toEqualTypeOf<Sink<string, undefined>>();
        return () => undefined;
      });
    };

    // Then
    expectTypeOf<{ handshake: 'open'; hello: string }>().toExtend<TransportOptions<string>>();
    expectTypeOf<{ handshake: 'open' }>().not.toExtend<TransportOptions<string>>();
    expect(typeOnly).toBeTypeOf('function');
  });

  it('As a peer, I serve and call over the same transport, and both directions work at once', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    opener.handleRequest(echo.say, (text, { hello }) => ok(`the opener heard ${text} from the ${hello}`));
    accepter.handleRequest(echo.say, (text, { hello }) => ok(`the accepter heard ${text} from the ${hello}`));
    const fromAccepter = accepter.request(echo.say, 'ping');
    const fromOpener = opener.request(echo.say, 'pong');

    // When
    opener.connect();
    await timers.advance(0);

    // Then
    expect(await fromOpener).toEqual(ok('the accepter heard pong from the opener'));
    expect(await fromAccepter).toEqual(ok('the opener heard ping from the accepter'));
    expect(issues).toEqual([]);
  });

  it("As a relay, I interrupt with a peer's HostFailure and my caller hears the same reason", async () => {
    // Given a caller, a relay that serves it and subscribes onward, and an upstream that serves the relay
    const downstream = rig();
    const upstream = rig();
    const caller = downstream.opener;
    const relayServing = downstream.accepter;
    const relayCalling = upstream.opener;
    serveWatch(upstream.accepter);
    relayServing.handleSubscription(notes.watch, (start, _context, sink) => {
      return relayCalling.subscribe(notes.watch, start, {
        receive: value => {
          sink.receive(value);
        },
        interrupt: outcome => {
          sink.interrupt(outcome);
        },
        close: error => {
          sink.interrupt(err(hostFailure(error)));
        },
      });
    });
    caller.connect();
    relayCalling.connect();
    const heard = watcher();
    caller.subscribe(notes.watch, 'from the top', heard);
    await downstream.timers.advance(0);
    await upstream.timers.advance(0);

    // When the upstream goes away
    upstream.accepter.dispose(new RangeError('upstream gone'));
    await upstream.timers.advance(0);
    await downstream.timers.advance(0);

    // Then
    expect(heard.ends).toEqual([err(hostFailure('RangeError: upstream gone'))]);
    expect([...downstream.issues, ...upstream.issues]).toEqual([]);
  });

  it('As a receiver, a throw while I handle a message is reported and never reaches the provider', () => {
    // Given a provider of the owner's whose peer origin throws
    const listeners: ((data: ArrayBuffer) => void)[] = [];
    const bug = new Error('no origin today');
    const provider: Provider = {
      post: () => undefined,
      subscribe: listener => {
        listeners.push(listener);
        return () => undefined;
      },
      peerOrigin: () => {
        throw bug;
      },
      dispose: () => undefined,
    };
    const { issues, onIssue } = issueLog();
    const transport = createTransport(testSchema, provider, { handshake: 'accept', hello: 'accepter', onIssue });
    transport.handleRequest(notes.touch, () => ok());
    const hear = (data: ArrayBuffer): void => {
      for (const listener of listeners) {
        listener(data);
      }
    };
    hear(encodeFrame(frame, { id: 1, body: { tag: 'open', value: { version: VERSION, hello: str.enc('peer') } } }));

    // When
    const call = (): void => {
      const message = { tag: 'request' as const, value: undefined };
      hear(encodeFrame(notes.touch.frame, { id: 3, body: { tag: 'call', value: { trait: 0, method: 1, message } } }));
    };

    // Then
    expect(call).not.toThrow();
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'invalid',
        cause: expect.objectContaining({ message: 'The message could not be handled', cause: bug }) as Error,
      },
    ]);
  });

  it('As an owner, an issue hook that throws never reaches the provider, and the issue and the throw are logged', () => {
    // Given
    const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
    const listeners: ((data: ArrayBuffer) => void)[] = [];
    const provider: Provider = {
      post: () => undefined,
      subscribe: listener => {
        listeners.push(listener);
        return () => undefined;
      },
      peerOrigin: () => null,
      dispose: () => undefined,
    };
    createTransport(testSchema, provider, {
      handshake: 'accept',
      hello: 'accepter',
      onIssue: () => {
        throw new Error('hook bug');
      },
    });

    // When
    const hear = (): void => {
      for (const listener of listeners) {
        listener(Uint8Array.of(0xff, 0xff, 0xff).buffer);
      }
    };

    // Then
    expect(hear).not.toThrow();
    expect(errors.map(line => line.message)).toEqual([
      '[transport] A message was refused as malformed, RangeError: Offset is outside the bounds of the DataView',
      '[transport] A listener threw, Error: The issue hook threw, Error: hook bug',
    ]);
  });

  it('As a caller, a receive or interrupt for a subscription I never opened is refused as invalid', async () => {
    // Given
    const { transport, timers, peer, issues, answerHandshake } = rawRig('open');
    transport.connect();
    await timers.advance(0);
    answerHandshake();

    // When
    peer.call(notes.watch, 41, { tag: 'receive', value: 'a line' });
    peer.call(notes.watch, 41, { tag: 'interrupt', value: ok() });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      { kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error },
      { kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error },
    ]);
    expect(peer.names()).toEqual(['open']);
  });

  it('As an owner with no issue hook, each issue is logged as one bounded error', async () => {
    // Given
    const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
    const { left, right } = createProviderPair();
    const timers = manualTimers();
    const opener = createTransport(
      testSchema,
      {
        ...left,
        post: () => {
          throw new Error('x'.repeat(1_000));
        },
      },
      { handshake: 'open', hello: 'opener', timers },
    );

    // When
    right.post(Uint8Array.of(0xff, 0xff, 0xff).buffer);
    await timers.advance(0);
    opener.connect();
    await timers.advance(0);

    // Then
    const [refused, posted] = errors.map(line => line.message);
    expect(errors).toHaveLength(2);
    expect(refused).toBe(
      '[transport] A message was refused as malformed, RangeError: Offset is outside the bounds of the DataView',
    );
    expect(posted).toMatch(/^\[transport\] A message could not be posted, Error: x+$/);
    expect(posted).toHaveLength(200);
  });

  it('As an owner, disposing releases the provider, and a later connect posts nothing', async () => {
    // Given
    const { left } = createProviderPair();
    const timers = manualTimers();
    const unsubscribed = vi.fn();
    const post = vi.fn();
    const dispose = vi.fn();
    const provider: Provider = {
      ...left,
      subscribe: listener => {
        const unsubscribe = left.subscribe(listener);
        return () => {
          unsubscribed();
          unsubscribe();
        };
      },
      post,
      dispose,
    };
    const transport = createTransport(testSchema, provider, { handshake: 'open', hello: 'opener', timers });

    // When
    transport.dispose(new Error('the page is closing'));
    transport.dispose(new Error('again'));
    transport.connect();
    await timers.advance(1_000);

    // Then
    expect(unsubscribed).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalled();
  });
});

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
    handle();
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
    handle();
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
    again();
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
    ticks();
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

describe('the handshake', () => {
  it('As an opener whose hello does not encode, my handshake fails with why and my calls reject with it', async () => {
    // Given
    const refused = new RangeError('this hello does not encode');
    const hello = codec<string>(
      () => {
        throw refused;
      },
      () => '',
    );
    const schema = defineSchema({ version: VERSION, hello, traits: { notes: { touch: notes.touch } } });
    const transport = createTransport(schema, createProviderPair().left, {
      handshake: 'open',
      hello: 'opener',
      timers: manualTimers(),
    });
    const call = outcomeOf(transport.request(notes.touch, undefined));

    // When
    transport.connect();

    // Then
    expect(await outcomeOf(transport.whenConnected())).toBe(refused);
    expect(await call).toBe(refused);
  });

  it('As a peer, each side hears the other side once the opener connects, and the accepter needs no connect', async () => {
    // Given
    const { opener, accepter, timers } = rig();
    const opened = outcomeOf(opener.whenConnected());
    const accepted = outcomeOf(accepter.whenConnected());

    // When
    accepter.connect();
    opener.connect();
    opener.connect();
    await timers.advance(0);

    // Then
    expect(await opened).toEqual({ value: undefined });
    expect(await accepted).toEqual({ value: undefined });
  });

  it('As an opener, my handshake times out only on the running clock and survives a garbage answer', async () => {
    // Given
    const { transport, timers, peer, issues } = rawRig('open');
    transport.connect();
    let settled: unknown;
    void outcomeOf(transport.whenConnected()).then(outcome => {
      settled = outcome;
    });

    // When
    peer.sendBytes(0xff, 0xff, 0xff);
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'malformed',
        cause: expect.any(RangeError) as RangeError,
      },
    ]);
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
    expect(settled).toBeInstanceOf(TransportHandshakeTimeoutError);
  });

  it('As an opener, a handshake answer after my handshake timed out changes nothing', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = rawRig('open');
    const call = outcomeOf(transport.request(notes.touch, undefined));
    transport.connect();
    await timers.advance(TIMEOUT_MS);
    const timedOut = await outcomeOf(transport.whenConnected());
    expect(timedOut).toBeInstanceOf(TransportHandshakeTimeoutError);
    const heard = peer.heard.length;

    // When
    answerHandshake();
    await timers.advance(RETRY_MS * 10);

    // Then
    expect(await outcomeOf(transport.whenConnected())).toBe(timedOut);
    expect(await call).toBe(timedOut);
    expect(await outcomeOf(transport.request(notes.touch, undefined))).toBe(timedOut);
    expect(peer.heard).toHaveLength(heard);
  });

  it('As an opener, a peer of another version fails my handshake at once with both versions', async () => {
    // Given
    const { transport, timers, peer } = rawRig('open');
    transport.connect();
    const call = outcomeOf(transport.request(notes.touch, undefined));
    await timers.advance(0);
    const attempt = must(peer.heard[0], 'a handshake');

    // When
    peer.send(attempt.id, { tag: 'accept', value: err({ version: VERSION + 1 }) });
    await timers.advance(0);

    // Then
    const failure = await outcomeOf(transport.whenConnected());
    expect(failure).toBeInstanceOf(TransportVersionMismatchError);
    expect(failure).toMatchObject({
      message: `The peer speaks version ${String(VERSION + 1)} and this side ${String(VERSION)}`,
    });
    expect(await call).toBe(failure);
    const heard = peer.heard.length;
    await timers.advance(RETRY_MS * 10);
    expect(peer.heard).toHaveLength(heard);
  });

  it('As an opener, every retry and flush posts a fresh buffer', async () => {
    // Given
    const { transport, timers, peer, left, answerHandshake } = rawRig('open');
    const post = vi.spyOn(left, 'post');
    const calls = [1, 2, 3].map(() => outcomeOf(transport.request(notes.touch, undefined)));

    // When
    transport.connect();
    await timers.advance(RETRY_MS * 3);
    answerHandshake();
    await transport.whenConnected();
    await timers.advance(0);

    // Then
    expect(peer.names()).toEqual([
      'open',
      'open',
      'open',
      'open',
      'request:notes.touch',
      'request:notes.touch',
      'request:notes.touch',
    ]);
    expect(post.mock.results.every(result => result.type === 'return')).toBe(true);
    const done = new Error('done');
    transport.dispose(done);
    expect(await Promise.all(calls)).toEqual([done, done, done]);
  });

  it('As an opener, a provider that cannot post fails my handshake at once with why and reports the post', async () => {
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
    const { issues, onIssue } = issueLog();
    const transport = createTransport(testSchema, provider, { handshake: 'open', hello: 'opener', timers, onIssue });

    // When
    transport.connect();
    const outcome = outcomeOf(transport.whenConnected());
    await timers.advance(0);

    // Then
    expect(await outcome).toMatchObject({ cause: broken });
    expect(issues).toEqual([{ kind: 'post_failed', error: broken }]);
  });

  it('As an accepter, I answer every handshake attempt with the outcome of the first', async () => {
    // Given
    const { transport, timers, peer, openHandshake } = rawRig('accept');

    // When
    openHandshake(VERSION, 1);
    openHandshake(VERSION, 3);
    await timers.advance(0);

    // Then
    expect(peer.accepts()).toEqual([
      { id: 1, value: ok(str.enc('accepter')) },
      { id: 3, value: ok(str.enc('accepter')) },
    ]);
    await expect(transport.whenConnected()).resolves.toBeUndefined();
  });

  it('As an accepter, I refuse every attempt of another version and close with both versions', async () => {
    // Given
    const { transport, timers, peer, openHandshake } = rawRig('accept');
    const call = outcomeOf(transport.request(notes.touch, undefined));

    // When
    openHandshake(VERSION + 1, 1);
    openHandshake(VERSION + 1, 3);
    await timers.advance(0);

    // Then
    expect(peer.accepts()).toEqual([
      { id: 1, value: err({ version: VERSION }) },
      { id: 3, value: err({ version: VERSION }) },
    ]);
    const failure = await outcomeOf(transport.whenConnected());
    expect(failure).toBeInstanceOf(TransportVersionMismatchError);
    expect(failure).toMatchObject({
      message: `The peer speaks version ${String(VERSION + 1)} and this side ${String(VERSION)}`,
    });
    expect(await call).toBe(failure);
    expect(peer.names()).not.toContain('request:notes.touch');
  });

  it('As an opener, a handshake answer before I connect is refused as invalid', async () => {
    // Given
    const { transport, timers, peer, issues } = rawRig('open');
    let connected = false;
    void transport.whenConnected().then(() => {
      connected = true;
    });

    // When
    peer.send(1, { tag: 'accept', value: ok(str.enc('peer')) });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error }]);
    expect(connected).toBe(false);
  });

  it('As an accepter, an answer I cannot post leaves me unconnected and the next attempt is answered afresh', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = breakable(broken);
    const { transport, timers, peer, issues, openHandshake } = rawRig('accept', wrap);
    void transport.request(notes.touch, undefined);
    let connected = false;
    void transport.whenConnected().then(() => {
      connected = true;
    });
    breakPosts();

    // When
    openHandshake(VERSION, 1);
    await timers.advance(0);

    // Then
    expect(issues).toEqual([{ kind: 'post_failed', error: broken }]);
    expect(connected).toBe(false);

    // When
    mendPosts();
    openHandshake(VERSION, 3);
    await timers.advance(0);

    // Then
    expect(peer.accepts()).toEqual([{ id: 3, value: ok(str.enc('accepter')) }]);
    expect(connected).toBe(true);
    expect(peer.names()).toEqual(['accept', 'request:notes.touch']);
  });

  it('As either side, a handshake leg meant for the other side is refused as invalid', async () => {
    // Given
    const opening = rawRig('open');
    const accepting = rawRig('accept');

    // When
    opening.openHandshake();
    accepting.peer.send(1, { tag: 'accept', value: ok(str.enc('peer')) });
    await opening.timers.advance(0);

    // Then
    expect(opening.issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error }]);
    expect(accepting.issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error }]);
    expect(opening.peer.heard).toEqual([]);
    expect(accepting.peer.heard).toEqual([]);
  });
});
