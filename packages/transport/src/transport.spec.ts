// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { type ResultPayload, str } from 'scale-ts';
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest';
import { deferred, toHex } from '@dotli/shared';
import { manualTimers, must, recordLog } from '@dotli/shared/testing';
import {
  TransportHandshakeTimeoutError,
  TransportMalformedResponseError,
  TransportUnsupportedProtocolVersionError,
  cancelled,
  denied,
  domain,
  err,
  hostFailure,
  malformedFrame,
  ok,
  unsupported,
  type CallError,
  type Failure,
  type TransportIssue,
} from './errors.js';
import { createProviderPair } from './provider.fake.js';
import type { Provider } from './provider.js';
import { codec, defineSchema, type AnyMethod } from './schema.js';
import {
  breakable,
  countedSchema,
  CUT_SHORT_TEXT,
  echo,
  forwardRig,
  issueLog,
  messageHex,
  namesOf,
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
  TRAILED_REASON,
  TRAILED_STOP,
  TRAILED_TEXT,
  UNKNOWN_LEG,
  VERSION,
  watcher,
} from './testing/rig.js';
import { createTransport, type CallContext, type Sink, type Transport, type TransportOptions } from './transport.js';
import { WIRE_VERSION, frame } from './wire.js';

/** The ids of the subscriptions a raw peer heard start, in order. */
const startIds = (peer: { find: (leg: string) => { id: number }[] }): number[] =>
  peer.find('start:notes.watch').map(message => message.id);

/** A transport that opened toward a raw peer, with the handshake answered. */
async function connectedRaw(wrap?: Parameters<typeof rawRig>[1], watched?: Parameters<typeof rawRig>[2]) {
  const raw = rawRig('offer', wrap, watched);
  raw.transport.connect();
  await raw.timers.advance(0);
  raw.answerHandshake();
  await raw.transport.whenConnected();
  return raw;
}

/** A transport that accepted a raw peer's handshake. */
async function acceptedRaw(wrap?: Parameters<typeof rawRig>[1], watched?: Parameters<typeof rawRig>[2]) {
  const raw = rawRig('respond', wrap, watched);
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
      const unsubscribe = transport.subscribe(notes.watch, 'from the top', {
        receive: value => {
          expectTypeOf(value).toEqualTypeOf<string>();
        },
        interrupt: outcome => {
          expectTypeOf(outcome).toEqualTypeOf<ResultPayload<undefined, string>>();
        },
        fail: failure => {
          expectTypeOf(failure).toEqualTypeOf<Failure>();
        },
        close: error => {
          expectTypeOf(error).toEqualTypeOf<Error>();
        },
      });
      expectTypeOf(unsubscribe).toEqualTypeOf<() => void>();
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
      transport.handleSubscription(echo.relay, (_start, _context, sink) => {
        expectTypeOf(sink).toEqualTypeOf<Sink<string, ResultPayload<undefined, CallError<string>>>>();
        return () => undefined;
      });
      transport.handleSubscription(notes.watch, (_start, _context, sink) => {
        // @ts-expect-error an interrupt carries the method's own type, which is text
        sink.interrupt(err(hostFailure('not the method own type')));
        return () => undefined;
      });
    };

    // Then
    expectTypeOf<{ handshake: 'offer'; hello: string }>().toExtend<TransportOptions<string>>();
    expectTypeOf<{ handshake: 'offer' }>().not.toExtend<TransportOptions<string>>();
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
    upstream.accepter.handleSubscription(notes.watch, () => {
      throw new RangeError('upstream gone');
    });
    relayServing.handleSubscription(echo.relay, (start, _context, sink) => {
      return relayCalling.subscribe(notes.watch, start, {
        receive: value => {
          sink.send(value);
        },
        interrupt: outcome => {
          sink.interrupt(outcome.success ? outcome : err(domain(outcome.value)));
        },
        fail: failure => {
          sink.interrupt(err(failure));
        },
        close: error => {
          sink.interrupt(err(hostFailure(error)));
        },
      });
    });
    caller.connect();
    relayCalling.connect();
    const heard = watcher<ResultPayload<undefined, CallError<string>>>();

    // When the caller subscribes, and the upstream's handler throws
    caller.subscribe(echo.relay, 'from the top', heard);
    await downstream.timers.advance(0);
    await upstream.timers.advance(0);
    await downstream.timers.advance(0);

    // Then
    expect(heard.ends).toEqual([err(hostFailure('RangeError: upstream gone'))]);
    expect(heard.fails).toEqual([]);
    expect([...downstream.issues, ...upstream.issues]).toEqual([]);
  });

  it('As a receiver, a throw while I handle a message is reported and never reaches the provider', () => {
    // Given a schema of the owner's whose method lookup throws
    const callbacks: ((message: Uint8Array) => void)[] = [];
    const bug = new Error('no methods today');
    const schema = {
      ...testSchema,
      methodAt: () => {
        throw bug;
      },
    };
    const provider: Provider = {
      isCorrectEnvironment: () => true,
      postMessage: () => undefined,
      subscribe: callback => {
        callbacks.push(callback);
        return () => undefined;
      },
      dispose: () => undefined,
    };
    const { issues, onIssue } = issueLog();
    const transport = createTransport(schema, provider, { handshake: 'respond', hello: 'accepter', onIssue });
    transport.handleRequest(notes.touch, () => ok());
    const hear = (message: Uint8Array): void => {
      for (const callback of callbacks) {
        callback(message);
      }
    };
    hear(
      frame.enc({
        id: 1,
        body: {
          tag: 'handshakeOffer',
          value: { versions: { wire: WIRE_VERSION, schema: VERSION }, hello: str.enc('peer') },
        },
      }),
    );

    // When
    const call = (): void => {
      const message = { tag: 'request' as const, value: undefined };
      hear(notes.touch.frame.enc({ id: 3, body: { tag: 'call', value: { sectionId: 0, methodId: 1, message } } }));
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
    const callbacks: ((message: Uint8Array) => void)[] = [];
    const provider: Provider = {
      isCorrectEnvironment: () => true,
      postMessage: () => undefined,
      subscribe: callback => {
        callbacks.push(callback);
        return () => undefined;
      },
      dispose: () => undefined,
    };
    createTransport(testSchema, provider, {
      handshake: 'respond',
      hello: 'accepter',
      onIssue: () => {
        throw new Error('hook bug');
      },
    });

    // When
    const hear = (): void => {
      for (const callback of callbacks) {
        callback(Uint8Array.of(0xff, 0xff, 0xff));
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
    const { transport, timers, peer, issues, answerHandshake } = rawRig('offer');
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
    expect(peer.names()).toEqual(['handshakeOffer']);
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
        postMessage: () => {
          throw new Error('x'.repeat(1_000));
        },
      },
      { handshake: 'offer', hello: 'opener', timers },
    );

    // When
    right.postMessage(Uint8Array.of(0xff, 0xff, 0xff));
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
      subscribe: callback => {
        const unsubscribe = left.subscribe(callback);
        return () => {
          unsubscribed();
          unsubscribe();
        };
      },
      postMessage: post,
      dispose,
    };
    const transport = createTransport(testSchema, provider, { handshake: 'offer', hello: 'opener', timers });

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

  it('As an owner, disposing posts nothing: no failure for a call I serve and no stop for a subscription I made, as truapi posts none', async () => {
    // Given a call and a subscription the peer made, and a subscription this side made
    const { transport, timers, peer } = await acceptedRaw();
    transport.handleRequest(notes.touch, () => new Promise(() => undefined));
    const { stops } = serveWatch(transport);
    peer.call(notes.touch, 3, { tag: 'request', value: undefined });
    peer.call(notes.watch, 5, { tag: 'start', value: 'from the top' });
    const heard = watcher();
    transport.subscribe(notes.watch, 'mine', heard);
    await timers.advance(0);
    const posted = peer.names();

    // When
    const reason = new Error('the page is closing');
    transport.dispose(reason);
    await timers.advance(0);

    // Then the peer heard nothing more, and each side's own end still settled here
    expect(posted).toEqual(['handshakeResponse', 'start:notes.watch']);
    expect(peer.names()).toEqual(posted);
    expect(stops).toEqual([1]);
    expect(heard.closes).toEqual([reason]);
  });

  it('As an owner, my issue hook hears a post the provider throws on before any call hears the close', async () => {
    // Given an open subscription, and a hook that notes what the subscription heard when the post failed
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts } = breakable(broken);
    const heard = watcher();
    const closesAtIssue: number[] = [];
    const raw = await connectedRaw(wrap, {
      onIssue: () => {
        closesAtIssue.push(heard.closes.length);
      },
    });
    raw.transport.subscribe(notes.watch, 'from the top', heard);
    await raw.timers.advance(0);

    // When
    breakPosts();
    const call = outcomeOf(raw.transport.request(notes.touch, undefined));
    await raw.timers.advance(0);

    // Then
    expect(closesAtIssue).toEqual([0]);
    expect(heard.closes).toEqual([broken]);
    expect(await call).toBe(broken);
  });

  it('As an owner, a provider not in a correct environment closes my transport at once and nothing is posted', async () => {
    // Given
    const { left } = createProviderPair();
    const timers = manualTimers();
    const post = vi.fn();
    const provider: Provider = { ...left, isCorrectEnvironment: () => false, postMessage: post };

    // When
    const transport = createTransport(testSchema, provider, { handshake: 'offer', hello: 'opener', timers });
    transport.connect();
    const heard = watcher();
    transport.subscribe(notes.watch, 'from the top', heard);
    const call = outcomeOf(transport.request(notes.touch, undefined));
    await timers.advance(1_000);

    // Then
    const closed = expect.objectContaining({ message: 'Environment is not correct' }) as Error;
    expect(await call).toEqual(closed);
    expect(await outcomeOf(transport.whenConnected())).toEqual(closed);
    expect(heard.closes).toEqual([closed]);
    expect(heard.ends).toEqual([]);
    expect(heard.fails).toEqual([]);
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
    const { transport, timers, peer, answerHandshake } = rawRig('offer');
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
      'handshakeOffer',
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
    expect(peer.names()).toEqual(['handshakeOffer', 'request:notes.read']);
    expect(detach).toHaveBeenCalledOnce();
    // A call still waiting would be settled again by the dispose, and detach its listener a second time.
    transport.dispose(new Error('done'));
    expect(detach).toHaveBeenCalledOnce();
  });

  it('As a caller, a call aborted while queued settles once as Cancelled and never posts, even when the handshake then fails', async () => {
    // Given
    const { transport, timers, peer } = rawRig('offer');
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
    expect(new Set(peer.names())).toEqual(new Set(['handshakeOffer']));
  });

  it('As a caller, a call aborted while queued never goes out once the handshake succeeds', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = rawRig('offer');
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
    expect(peer.names()).toEqual(['handshakeOffer']);
  });

  it('As a caller, a call with an already aborted signal resolves Cancelled at once and posts nothing', async () => {
    // Given
    const { transport, timers, peer } = await connectedRaw();

    // When
    const call = transport.request(notes.touch, undefined, { signal: AbortSignal.abort() });

    // Then a marker settled after the call loses the race, so the call settled before any queue step
    expect(await Promise.race([call, Promise.resolve('still waiting')])).toEqual(err(cancelled()));
    await timers.advance(0);
    expect(peer.names()).toEqual(['handshakeOffer']);
  });

  it('As a caller, an answer that does not decode rejects my call with TransportMalformedResponseError and is reported', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const call = outcomeOf(transport.request(notes.read, 'note'));
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');

    // When an Ok answer to the call carries text that is cut short
    peer.call(rawRead, asked.id, { tag: 'response', value: ok(CUT_SHORT_TEXT) }, notes.read);
    await timers.advance(0);

    // Then the call rejects with why it does not decode as its cause
    const rejected = await call;
    expect(rejected).toBeInstanceOf(TransportMalformedResponseError);
    expect(rejected).toMatchObject({
      message: 'The answer to notes.read does not decode, RangeError: Invalid DataView length 2',
      cause: expect.any(RangeError) as RangeError,
    });
    expect(issues).toEqual([{ kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError }]);
  });

  it('As a caller, an answer or a failure that leaves bytes unread is refused as malformed, as truapi refuses it', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const answered = outcomeOf(transport.request(notes.read, 'note'));
    const failed = outcomeOf(transport.request(notes.read, 'other'));
    await timers.advance(0);
    const [first, second] = peer.find('request:notes.read').map(message => message.id);

    // When one answer carries text with a byte after it, and a failure frame of the other has a byte after it
    peer.call(rawRead, must(first, 'the first call'), { tag: 'response', value: ok(TRAILED_TEXT) }, notes.read);
    peer.sendBytes(...frame.enc({ id: must(second, 'the second call'), body: { tag: 'failed', value: denied() } }), 0);
    await timers.advance(0);

    // Then the answer rejects as malformed, and the frame is refused while its call waits on
    expect(await answered).toMatchObject({
      name: 'TransportMalformedResponseError',
      message: `The answer to notes.read does not decode, ${TRAILED_REASON}`,
    });
    expect(issues).toEqual([
      { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError },
      { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError },
    ]);
    let settled = false;
    void failed.then(() => {
      settled = true;
    });
    await timers.advance(0);
    expect(settled).toBe(false);
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

  it('As a caller, a call my provider cannot post rejects with why, the post is reported, and my transport closes with it, as truapi closes', async () => {
    // Given an open subscription and a call the peer holds
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = breakable(broken);
    const { transport, timers, issues, peer } = await connectedRaw(wrap);
    const heard = watcher();
    transport.subscribe(notes.watch, 'from the top', heard);
    const held = outcomeOf(transport.request(notes.read, 'note'));
    await timers.advance(0);

    // When
    breakPosts();
    const call = outcomeOf(transport.request(notes.touch, undefined));
    await timers.advance(0);
    mendPosts();

    // Then the call, the held call and the subscription hear the provider's error, after the hook heard the post
    expect(await call).toBe(broken);
    expect(await held).toBe(broken);
    expect(heard.closes).toEqual([broken]);
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { section: 'notes', method: 'touch' } }]);
    // And the closed transport posts nothing more, not even a stop for the subscription
    expect(await outcomeOf(transport.request(notes.touch, undefined))).toBe(broken);
    expect(peer.names()).toEqual(['handshakeOffer', 'start:notes.watch', 'request:notes.read']);
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
    const { transport, timers, peer, left } = rawRig('offer');
    transport.connect();
    const call = outcomeOf(transport.request(notes.touch, undefined));
    await timers.advance(100);
    expect(peer.names()).toEqual(['handshakeOffer', 'handshakeOffer', 'handshakeOffer']);
    const post = vi.spyOn(left, 'postMessage');
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
    const { transport, timers, peer, answerHandshake } = rawRig('offer');
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
      'handshakeOffer',
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
    first.send('one');
    first.send('two');
    first.interrupt(ok());
    first.interrupt(err('twice'));
    first.send('late');
    second.interrupt(err('no such note'));
    second.interrupt(ok());
    await timers.advance(0);

    // Then
    expect(clean.values).toEqual(['one', 'two']);
    expect(clean.ends).toEqual([ok()]);
    expect(failed.values).toEqual([]);
    expect(failed.ends).toEqual([err('no such note')]);
    expect([...clean.fails, ...failed.fails]).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('As a subscriber, stopping while queued sends nothing and I hear nothing', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = rawRig('offer');
    const heard = watcher();
    const unsubscribe = transport.subscribe(notes.watch, 'from the top', heard);
    transport.connect();
    await timers.advance(0);

    // When
    unsubscribe();
    answerHandshake();
    await transport.whenConnected();
    await timers.advance(0);
    transport.dispose(new Error('done'));

    // Then
    expect(peer.names()).toEqual(['handshakeOffer']);
    expect(heard.ends).toEqual([]);
    expect(heard.fails).toEqual([]);
    expect(heard.closes).toEqual([]);
  });

  it('As a subscriber, stopping my open subscription posts one stop and I hear nothing more, a crossing interrupt included', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const heard = watcher();
    const unsubscribe = transport.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);
    const [id = 0] = startIds(peer);

    // When
    unsubscribe();
    unsubscribe();
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
    const unsubscribe = transport.subscribe(notes.watch, 'from the top', heard, { signal: abort.signal });
    await timers.advance(0);
    const [id = 0] = startIds(peer);

    // When
    abort.abort();
    unsubscribe();
    peer.call(notes.watch, id, { tag: 'receive', value: 'crossing' });
    await timers.advance(0);

    // Then
    expect(heard.fails).toEqual([cancelled()]);
    expect(heard.ends).toEqual([]);
    expect(heard.values).toEqual([]);
    expect(peer.find('stop:notes.watch').map(message => message.id)).toEqual([id]);
    expect(issues).toEqual([]);
  });

  it('As a caller, a subscription aborted while queued or before it is made posts nothing and I hear Cancelled once', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = rawRig('offer');
    const queued = watcher();
    const early = watcher();
    const abort = new AbortController();
    transport.subscribe(notes.watch, 'queued', queued, { signal: abort.signal });

    // When
    transport.subscribe(notes.watch, 'early', early, { signal: AbortSignal.abort() });

    // Then it hears nothing before the call returns
    expect(early.fails).toEqual([]);

    // When
    transport.connect();
    await timers.advance(0);
    abort.abort();
    answerHandshake();
    await transport.whenConnected();
    await timers.advance(0);

    // Then
    expect(queued.fails).toEqual([cancelled()]);
    expect(early.fails).toEqual([cancelled()]);
    expect(peer.names()).toEqual(['handshakeOffer']);
  });

  it('As a caller, a transport that closes closes my subscription once with its error', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const { stops } = serveWatch(accepter);
    opener.connect();
    const heard = watcher();
    opener.subscribe(notes.watch, 'open', heard);
    const stopped = watcher();
    const unsubscribe = opener.subscribe(notes.watch, 'stopped', stopped);
    await timers.advance(0);
    unsubscribe();
    const reason = new Error('the page is closing');

    // When
    opener.dispose(reason);
    opener.dispose(new Error('again'));
    await timers.advance(0);

    // Then the peer is told only of the stop made before the close
    expect(heard.closes).toEqual([reason]);
    expect(stopped.closes).toEqual([]);
    expect(heard.ends).toEqual([]);
    expect(heard.fails).toEqual([]);
    expect(stops).toEqual([0, 1]);

    // When a subscription is made once closed, and stopped before it hears
    const after = watcher();
    opener.subscribe(notes.watch, 'after', after);
    const stoppedAfter = watcher();
    opener.subscribe(notes.watch, 'stopped after', stoppedAfter)();
    await timers.advance(0);

    // Then
    expect(after.closes).toEqual([reason]);
    expect(stoppedAfter.closes).toEqual([]);
    expect(stops).toEqual([0, 1]);
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
    expect(heard.fails).toEqual([]);
    expect(heard.closes).toEqual([]);
    expect(peer.find('stop:notes.watch')).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('As a caller, disposing while my start is queued closes it with the reason and posts no start', async () => {
    // Given
    const { transport, timers, peer } = rawRig('offer');
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
    const { transport, timers, peer } = rawRig('offer');
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
      fail: vi.fn(() => undefined),
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
      sink.send('one');
      sink.send('two');
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
    const unsubscribeSelf = opener.subscribe(notes.watch, 'a', {
      receive: () => {
        heardBySelfStopping();
        unsubscribeSelf();
        unsubscribeSelf();
      },
      interrupt: () => undefined,
      fail: () => undefined,
      close: () => undefined,
    });
    const disposingCloses = vi.fn();
    opener.subscribe(notes.watch, 'b', {
      receive: () => {
        opener.dispose(reason);
      },
      interrupt: () => undefined,
      fail: () => undefined,
      close: disposingCloses,
    });
    const watcherCloses = vi.fn();
    let callFromClose: Promise<unknown> | undefined;
    const unsubscribeWatched = opener.subscribe(notes.watch, 'c', {
      ...watcher(),
      close: error => {
        watcherCloses(error);
        unsubscribeWatched();
        opener.dispose(new Error('second dispose'));
        callFromClose = outcomeOf(opener.request(echo.say, 'still there?'));
      },
    });
    await timers.advance(0);

    // When
    must(sinks[0], 'the first sink').send('one');
    must(sinks[0], 'the first sink').send('two');
    await timers.advance(0);
    must(sinks[1], 'the second sink').send('one');
    await timers.advance(0);

    // Then
    expect(heardBySelfStopping).toHaveBeenCalledOnce();
    expect(disposingCloses).toHaveBeenCalledExactlyOnceWith(reason);
    expect(watcherCloses).toHaveBeenCalledExactlyOnceWith(reason);
    expect(await callFromClose).toBe(reason);
    // And only the stop made before the dispose reached the peer
    expect(stops).toEqual([1, 0, 0]);
  });

  it('As a subscriber, disposing from inside interrupt tells the peer nothing', async () => {
    // Given
    const { transport, timers, peer } = await connectedRaw();
    transport.subscribe(notes.watch, 'ended', {
      receive: () => undefined,
      interrupt: () => {
        transport.dispose(new Error('torn down'));
      },
      fail: () => undefined,
      close: () => undefined,
    });
    transport.subscribe(notes.watch, 'open', watcher());
    await timers.advance(0);
    const [ended = 0, open = 0] = startIds(peer);

    // When
    peer.call(notes.watch, ended, { tag: 'interrupt', value: ok() });
    await timers.advance(0);

    // Then
    expect(open).not.toBe(0);
    expect(peer.find('stop:notes.watch')).toEqual([]);
  });

  it('As a caller, a message on a subscription I stopped is dropped quietly, and one that cannot be a race is refused as invalid', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const stopped = watcher();
    const interrupted = watcher();
    const open = watcher();
    const unsubscribeStopped = transport.subscribe(notes.watch, 'stopped', stopped);
    unsubscribeStopped();
    await timers.advance(0);
    transport.subscribe(notes.watch, 'interrupted', interrupted);
    transport.subscribe(notes.watch, 'open', open);
    await timers.advance(0);
    const [ended = 0, running = 0] = startIds(peer);
    peer.call(notes.watch, ended, { tag: 'interrupt', value: ok() });
    await timers.advance(0);
    const unsubscribeLater = transport.subscribe(notes.watch, 'later', watcher());
    await timers.advance(0);
    const [, , later = 0] = startIds(peer);
    unsubscribeLater();

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

    // When an interrupt carries a value that is cut short, and a value is cut short
    peer.call(rawWatch, a, { tag: 'interrupt', value: err(CUT_SHORT_TEXT) }, notes.watch);
    peer.call(rawWatch, b, { tag: 'receive', value: CUT_SHORT_TEXT }, notes.watch);
    await timers.advance(0);

    // Then both end, and only the value is stopped, since what did not decode may have been a value and nothing follows
    // an interrupt
    const malformed = malformedFrame('RangeError: Invalid DataView length 2');
    expect(first.fails).toEqual([malformed]);
    expect(second.fails).toEqual([malformed]);
    expect([...first.ends, ...second.ends]).toEqual([]);
    expect(peer.find('stop:notes.watch').map(message => message.id)).toEqual([b]);
    const refused = { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError };
    expect(issues).toEqual([refused, refused]);
  });

  it('As a caller, an interrupt or a value that leaves bytes unread ends my subscription as MalformedFrame, and only the value is stopped', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectedRaw();
    const first = watcher();
    const second = watcher();
    transport.subscribe(notes.watch, 'a', first);
    transport.subscribe(notes.watch, 'b', second);
    await timers.advance(0);
    const [a = 0, b = 0] = startIds(peer);

    // When an interrupt carries text with a byte after it, and so does a value
    peer.call(rawWatch, a, { tag: 'interrupt', value: err(TRAILED_TEXT) }, notes.watch);
    peer.call(rawWatch, b, { tag: 'receive', value: TRAILED_TEXT }, notes.watch);
    await timers.advance(0);

    // Then
    expect(first.fails).toEqual([malformedFrame(TRAILED_REASON)]);
    expect(second.fails).toEqual([malformedFrame(TRAILED_REASON)]);
    expect([...first.values, ...second.values, ...first.ends, ...second.ends]).toEqual([]);
    expect(peer.find('stop:notes.watch').map(message => message.id)).toEqual([b]);
    const refused = { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError };
    expect(issues).toEqual([refused, refused]);
  });

  it('As a caller, a message whose leg cannot be read ends my subscription as MalformedFrame and is stopped like a value', async () => {
    // Given
    const { transport, timers, peer } = await connectedRaw();
    const listeners = watcher();
    transport.subscribe(notes.watch, 'a', listeners);
    await timers.advance(0);
    const [id = 0] = startIds(peer);
    const { sectionId, methodId } = testSchema.addressOf(notes.watch);

    // When the message names a leg the method lacks
    peer.send(id, { tag: 'call', value: { sectionId, methodId, message: UNKNOWN_LEG } });
    await timers.advance(0);

    // Then
    expect(listeners.fails).toEqual([{ tag: 'MalformedFrame', value: { reason: expect.any(String) as string } }]);
    expect(peer.find('stop:notes.watch').map(message => message.id)).toEqual([id]);
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
    expect(heard.fails).toEqual([unsupported()]);
    expect(heard.ends).toEqual([]);
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
    expect(peer.names()).toEqual(['handshakeOffer']);
  });

  it('As a caller, an issue hook that disposes on my failed start post leaves the peer nothing to stop', async () => {
    // Given a hook that mends posts and disposes when the start cannot be posted
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = breakable(broken);
    const reason = new Error('leaving');
    const issues: TransportIssue[] = [];
    const raw = await connectedRaw(wrap, {
      onIssue: issue => {
        issues.push(issue);
        if (issue.kind === 'post_failed') {
          mendPosts();
          raw.transport.dispose(reason);
        }
      },
    });
    breakPosts();
    const heard = watcher();

    // When
    raw.transport.subscribe(notes.watch, 'from the top', heard);
    await raw.timers.advance(0);

    // Then the transport closed it before the post returned, and the peer heard no stop
    expect(heard.closes).toEqual([reason]);
    expect(heard.ends).toEqual([]);
    expect(heard.fails).toEqual([]);
    expect(raw.peer.names()).toEqual(['handshakeOffer']);
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { section: 'notes', method: 'watch' } }]);
  });

  it('As a caller, an issue hook that stops my subscription on its failed start post leaves the peer nothing to stop', async () => {
    // Given a hook that mends posts and stops the subscription when its start cannot be posted
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = breakable(broken);
    const issues: TransportIssue[] = [];
    // The `unsubscribe` is made after the hook, which runs only once the start is posted.
    const unsubscribes: (() => void)[] = [];
    const raw = await connectedRaw(wrap, {
      onIssue: issue => {
        issues.push(issue);
        if (issue.kind === 'post_failed') {
          mendPosts();
          unsubscribes[0]?.();
        }
      },
    });
    breakPosts();
    const heard = watcher();

    // When
    unsubscribes.push(raw.transport.subscribe(notes.watch, 'from the top', heard));
    await raw.timers.advance(0);
    raw.transport.dispose(new Error('done'));
    await raw.timers.advance(0);

    // Then `unsubscribe` ended it before the post returned, and the peer heard no stop
    expect(heard.closes).toEqual([]);
    expect(heard.ends).toEqual([]);
    expect(raw.peer.names()).toEqual(['handshakeOffer']);
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { section: 'notes', method: 'watch' } }]);
  });

  it('As a caller, a start my provider cannot post closes my subscription and my transport with why, and the post is reported', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = breakable(broken);
    const { transport, timers, peer, issues } = await connectedRaw(wrap);
    breakPosts();
    const heard = watcher();

    // When
    const unsubscribe = transport.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);
    mendPosts();
    unsubscribe();
    transport.dispose(new Error('done'));
    await timers.advance(0);

    // Then
    expect(heard.closes).toEqual([broken]);
    expect(await outcomeOf(transport.whenConnected())).toBe(broken);
    expect(heard.ends).toEqual([]);
    expect(heard.fails).toEqual([]);
    expect(peer.names()).toEqual(['handshakeOffer']);
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { section: 'notes', method: 'watch' } }]);
  });
});

describe('serving', () => {
  it("As a handler, I read the caller's hello", async () => {
    // Given
    const { left, right } = createProviderPair();
    const timers = manualTimers();
    const opener = createTransport(testSchema, left, { handshake: 'offer', hello: 'opener', timers });
    const accepter = createTransport(testSchema, right, { handshake: 'respond', hello: 'accepter' });
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
    expect(servedByAccepter).toHaveBeenCalledExactlyOnceWith('to the accepter', { hello: 'opener' });
    expect(servedByOpener).toHaveBeenCalledExactlyOnceWith('to the opener', { hello: 'accepter' });
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

  it('As a caller, my call in flight when the peer disposes hears nothing, and the late answer is never posted', async () => {
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

    // Then a marker settled after the late answer wins the race, since the call waits on
    expect(await Promise.race([call, Promise.resolve('still waiting')])).toBe('still waiting');
    expect(delivered).toHaveLength(posted);
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
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { section: 'notes', method: 'touch' } }]);
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

  it('As a serving side, a payload that leaves bytes unread is answered MalformedFrame and reported', async () => {
    // Given
    const { transport, timers, peer, issues } = await acceptedRaw();
    const handler = vi.fn(() => ok('never'));
    transport.handleRequest(notes.read, handler);

    // When a request on notes.read carries text with a byte after it
    peer.call(rawRead, 7, { tag: 'request', value: TRAILED_TEXT }, notes.read);
    await timers.advance(0);

    // Then
    expect(peer.failures()).toEqual([{ id: 7, value: malformedFrame(TRAILED_REASON) }]);
    expect(issues).toEqual([{ kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError }]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('As a serving side, a call to a method or a section this schema lacks is answered Unsupported, and a failure about a call I never made is refused', async () => {
    // Given
    const { timers, peer, issues } = await acceptedRaw();

    // When a method and a section this schema lacks are called
    peer.send(9, { tag: 'call', value: { sectionId: NOTES, methodId: 7, message: Uint8Array.of(0, 1, 2) } });
    peer.send(11, { tag: 'call', value: { sectionId: 7, methodId: 0, message: Uint8Array.of(0) } });
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
    expect(peer.names()).toEqual(['handshakeResponse', 'failed', 'failed']);
    expect(issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error }]);
  });

  it('As a serving side, a message of a kind its method lacks is answered MalformedFrame, and a response to the peer is refused as invalid', async () => {
    // Given
    const { transport, timers, peer, issues } = await acceptedRaw();
    serveWatch(transport);
    transport.handleRequest(notes.read, () => ok('never'));

    // When a message on notes.watch has a kind no subscription has, and a response comes for a call of the peer's
    peer.send(5, { tag: 'call', value: { sectionId: NOTES, methodId: 2, message: Uint8Array.of(4, 0x61) } });
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

  it('As a serving side, a call before the handshake is over is refused as invalid and answered HostFailure at once, and no handler runs', async () => {
    // Given
    const { transport, timers, peer, issues } = rawRig('respond');
    const handler = vi.fn(() => ok());
    transport.handleRequest(notes.touch, handler);
    const { starts } = serveWatch(transport);

    // When a request, a start, a request whose payload is cut short and a request to a method this schema lacks come first
    peer.call(notes.touch, 3, { tag: 'request', value: undefined });
    peer.call(notes.watch, 5, { tag: 'start', value: 'from the top' });
    peer.call(rawRead, 7, { tag: 'request', value: CUT_SHORT_TEXT }, notes.read);
    peer.send(9, { tag: 'call', value: { sectionId: NOTES, methodId: 7, message: Uint8Array.of(0, 1, 2) } });
    await timers.advance(0);

    // Then
    const refused = {
      kind: 'refused',
      reason: 'invalid',
      cause: expect.objectContaining({ message: 'A call came before the handshake' }) as Error,
    };
    expect(issues).toEqual([refused, refused, refused, refused]);
    const notOver = hostFailure('The handshake is not over');
    expect(peer.failures()).toEqual([
      { id: 3, value: notOver },
      { id: 5, value: notOver },
      { id: 7, value: notOver },
      { id: 9, value: notOver },
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(starts).toEqual([]);
  });

  it('As a serving side, a call after my handshake failed is refused as invalid with the failure and no reply', async () => {
    // Given
    const { timers, peer, issues, openHandshake } = rawRig('respond');
    openHandshake(VERSION + 1);
    await timers.advance(0);

    // When a call comes on a method of the schema and on one it lacks
    peer.call(notes.touch, 3, { tag: 'request', value: undefined });
    peer.send(5, { tag: 'call', value: { sectionId: NOTES, methodId: 7, message: Uint8Array.of(1, 0) } });
    await timers.advance(0);

    // Then
    const refused = {
      kind: 'refused',
      reason: 'invalid',
      cause: expect.objectContaining({
        message: `A call came after the transport closed, TransportUnsupportedProtocolVersionError: The peer speaks schema version ${String(VERSION + 1)} and this side ${String(VERSION)}.`,
      }) as Error,
    };
    expect(issues).toEqual([refused, refused]);
    expect(peer.names()).toEqual(['handshakeResponse']);
  });

  it('As a connected accepter, a malformed handshake open is reported with no reply', async () => {
    // Given
    const { timers, peer, issues } = await acceptedRaw();

    // When an open carries no version, then one carries a hello that is cut short
    peer.sendBytes(3, 0, 0, 0, 0);
    peer.send(5, {
      tag: 'handshakeOffer',
      value: { versions: { wire: WIRE_VERSION, schema: VERSION }, hello: CUT_SHORT_TEXT },
    });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError },
      { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError },
    ]);
    expect(peer.names()).toEqual(['handshakeResponse']);
  });

  it('As an accepter, a malformed handshake open is reported with no reply', async () => {
    // Given
    const { transport, timers, peer, issues } = rawRig('respond');
    let connected = false;
    void transport.whenConnected().then(() => {
      connected = true;
    });

    // When an open carries no version, then one carries a hello that is cut short
    peer.sendBytes(1, 0, 0, 0, 0);
    peer.send(3, {
      tag: 'handshakeOffer',
      value: { versions: { wire: WIRE_VERSION, schema: VERSION }, hello: CUT_SHORT_TEXT },
    });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError },
      { kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError },
    ]);
    expect(peer.heard).toEqual([]);
    expect(connected).toBe(false);
  });

  it('As either side, a hello that leaves bytes unread is refused as malformed and settles no handshake', async () => {
    // Given an accepter and an opener that both face a raw peer
    const accepter = rawRig('respond');
    const opener = rawRig('offer');
    opener.transport.connect();
    await opener.timers.advance(0);
    const attempt = must(opener.peer.find('handshakeOffer')[0], 'a handshake');

    // When each hears a hello with a byte after it
    accepter.peer.send(1, {
      tag: 'handshakeOffer',
      value: { versions: { wire: WIRE_VERSION, schema: VERSION }, hello: TRAILED_TEXT },
    });
    opener.peer.send(attempt.id, { tag: 'handshakeResponse', value: ok(TRAILED_TEXT) });
    await accepter.timers.advance(0);
    await opener.timers.advance(0);

    // Then the accepter answers nothing and the opener keeps trying
    const refused = [{ kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError }];
    expect(accepter.issues).toEqual(refused);
    expect(accepter.peer.names()).toEqual([]);
    expect(opener.issues).toEqual(refused);
    const heard = opener.peer.heard.length;
    await opener.timers.advance(RETRY_MS);
    expect(opener.peer.heard.length).toBeGreaterThan(heard);
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
    expect(peer.names()).toEqual(['handshakeResponse']);
  });

  it('As a serving side, a request that reuses the id of one still in flight is refused as invalid, as truapi refuses it, and its handler does not run again', async () => {
    // Given a request the handler holds
    const { transport, timers, peer, issues } = await acceptedRaw();
    const answer = deferred<ResultPayload<string, CallError<string>>>();
    const handler = vi.fn(() => answer.promise);
    transport.handleRequest(notes.read, handler);
    peer.call(notes.read, 3, { tag: 'request', value: 'first' });
    await timers.advance(0);

    // When the peer sends another request on its id, and the first is then answered
    peer.call(notes.read, 3, { tag: 'request', value: 'second' });
    await timers.advance(0);
    answer.resolve(ok('the first'));
    await timers.advance(0);

    // Then
    expect(handler).toHaveBeenCalledOnce();
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'invalid',
        cause: expect.objectContaining({ message: 'A request reuses call 3, which is still in flight' }) as Error,
      },
    ]);
    expect(peer.values(notes.read, 'response:notes.read')).toEqual([ok('the first')]);

    // When the id is reused once the first was answered
    peer.call(notes.read, 3, { tag: 'request', value: 'third' });
    await timers.advance(0);

    // Then it is served
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('As a serving side, I refuse an unreadable subscription message that reuses an in-flight request id and answer only the request', async () => {
    // Given a request the handler holds on id 3, beside a served subscription
    const { transport, timers, peer, issues } = await acceptedRaw();
    const answer = deferred<ResultPayload<string, CallError<string>>>();
    transport.handleRequest(notes.read, () => answer.promise);
    transport.handleSubscription(notes.watch, () => () => undefined);
    peer.call(notes.read, 3, { tag: 'request', value: 'first' });
    await timers.advance(0);
    const { sectionId, methodId } = testSchema.addressOf(notes.watch);

    // When the peer sends a subscription message it cannot read on that id, and the request is then answered
    peer.send(3, { tag: 'call', value: { sectionId, methodId, message: UNKNOWN_LEG } });
    await timers.advance(0);
    answer.resolve(ok('the first'));
    await timers.advance(0);

    // Then the request in flight keeps its id, and only its answer is posted
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'invalid',
        cause: expect.objectContaining({ message: 'A request reuses call 3, which is still in flight' }) as Error,
      },
    ]);
    expect(peer.names()).toEqual(['handshakeResponse', 'response:notes.read']);
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

  it("As a handler, I read the subscriber's start and hello, and the peer's stop runs my stop function once", async () => {
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

    // Then the second stop stops nothing and is dropped quietly
    expect(started).toEqual([{ start: 'from the top', context: { hello: 'peer' } }]);
    expect(stop).toHaveBeenCalledOnce();
    expect(peer.names()).toEqual(['handshakeResponse']);
    expect(issues).toEqual([]);
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
    expect(heard.fails).toEqual([hostFailure('TypeError: bad start')]);
    expect(heard.ends).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('As a handler, I interrupt inside start and my stop function still runs once', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const stop = vi.fn();
    accepter.handleSubscription(notes.watch, (_start, _context, sink) => {
      sink.send('only');
      sink.interrupt(err('at once'));
      return stop;
    });
    opener.connect();
    const heard = watcher();

    // When
    opener.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);

    // Then
    expect(heard.values).toEqual(['only']);
    expect(heard.ends).toEqual([err('at once')]);
    expect(stop).toHaveBeenCalledOnce();
    expect(issues).toEqual([]);
  });

  it('As either side, a stop crossing an interrupt is ignored by both', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const { sinks, stops } = serveWatch(accepter);
    opener.connect();
    const heard = watcher();
    const unsubscribe = opener.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);

    // When
    unsubscribe();
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
    const unsubscribe = opener.subscribe(notes.watch, 'from the top', watcher());
    await timers.advance(0);
    unsubscribe();
    await timers.advance(0);
    const posted = delivered.length;

    // When
    const sink = must(sinks[0], 'a sink');
    sink.send('late');
    sink.interrupt(ok());
    sink.interrupt(err('again'));
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
    must(sinks[0], 'the first sink').send('');
    must(sinks[1], 'the second sink').interrupt(err('gone'));
    await timers.advance(0);

    // Then
    expect(first.fails).toEqual([hostFailure('RangeError: A word is never empty')]);
    expect(second.ends).toEqual([err('gone')]);
    expect(stops).toEqual([1, 1]);
  });

  it('As a handler, a value my provider cannot post is reported, closes my transport and runs my stop, and nothing is thrown into my call', async () => {
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
      sink.send('a line');
    };
    const interrupt = (): void => {
      sink.interrupt(ok());
    };

    // Then
    expect(receive).not.toThrow();
    expect(interrupt).not.toThrow();
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { section: 'notes', method: 'watch' } }]);
    expect(stops).toEqual([1]);
    expect(await outcomeOf(transport.whenConnected())).toBe(broken);
  });

  it('As a serving side, disposing tells no subscription I serve, and runs each stop', async () => {
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
      expect(listeners.fails).toEqual([]);
      expect(listeners.ends).toEqual([]);
      expect(listeners.closes).toEqual([]);
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

  it('As a serving side, a start that reuses the id of a running subscription replaces it with nothing sent, as truapi does, and a stop that names another method is refused as invalid with no reply', async () => {
    // Given
    const { transport, timers, peer, issues } = await acceptedRaw();
    const { starts, stops } = serveWatch(transport);
    peer.call(notes.watch, 5, { tag: 'start', value: 'first' });
    await timers.advance(0);

    // When
    peer.call(notes.watch, 5, { tag: 'start', value: 'second' });
    peer.call(echo.listen, 5, { tag: 'stop', value: undefined });
    await timers.advance(0);

    // Then the first stopped and the second runs
    expect(starts).toEqual(['first', 'second']);
    expect(stops).toEqual([1, 0]);
    expect(issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error }]);
    expect(peer.names()).toEqual(['handshakeResponse']);

    // When the peer stops the one that replaced it
    peer.call(notes.watch, 5, { tag: 'stop', value: undefined });
    await timers.advance(0);

    // Then
    expect(stops).toEqual([1, 1]);
  });

  it('As a serving side, what a peer that disposes opened keeps running, since it posts nothing', async () => {
    // Given a peer with a subscription
    const { opener, accepter, timers } = rig();
    const { stops } = serveWatch(accepter);
    opener.subscribe(notes.watch, 'tick', watcher());
    await timers.advance(0);

    // When the peer disposes its transport
    opener.dispose(new Error('leaving'));
    await timers.advance(0);

    // Then
    expect(stops).toEqual([0]);
  });

  it('As a handler, my stop function that disposes the transport still lets the peer hear my interrupt', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    const sinks: Sink<string, ResultPayload<undefined, string>>[] = [];
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
    must(sinks[0], 'the first sink').interrupt(err('finished'));
    await timers.advance(0);

    // Then the other subscription hears nothing, since a closing side posts nothing
    expect(ended.ends).toEqual([err('finished')]);
    expect(other.fails).toEqual([]);
    expect(other.ends).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('As a serving side, a stop before the handshake is refused as invalid, and one for a subscription that is not running is dropped quietly', async () => {
    // Given
    const { transport, timers, peer, issues, openHandshake } = rawRig('respond');
    serveWatch(transport);

    // When a stop comes before the handshake, then one names an id never started, and one a method with no handler
    peer.call(notes.watch, 1, { tag: 'stop', value: undefined });
    await timers.advance(0);
    openHandshake();
    await timers.advance(0);
    peer.call(notes.watch, 3, { tag: 'stop', value: undefined });
    peer.call(echo.listen, 5, { tag: 'stop', value: undefined });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'invalid',
        cause: expect.objectContaining({ message: 'A call came before the handshake' }) as Error,
      },
    ]);
    expect(peer.names()).toEqual(['handshakeResponse']);
  });
});

describe('the handshake', () => {
  it('As an owner whose hello does not encode, either side fails at creation with why', () => {
    // Given
    const refused = new RangeError('this hello does not encode');
    const hello = codec<string>(
      () => {
        throw refused;
      },
      () => '',
    );
    const schema = defineSchema({ version: VERSION, hello, sections: { notes: { touch: notes.touch } } });
    const { left, right } = createProviderPair();

    // When
    const create = (provider: Provider, handshake: 'offer' | 'respond') => () =>
      createTransport(schema, provider, { handshake, hello: 'a side', timers: manualTimers() });

    // Then
    expect(create(left, 'offer')).toThrow(refused);
    expect(create(right, 'respond')).toThrow(refused);
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
    const { transport, timers, peer, issues } = rawRig('offer');
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

  it('As an owner that bounds the wait itself, my opener with no deadline keeps offering past the default one until it is answered', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = rawRig('offer', undefined, { timeoutMs: null });
    const opened = outcomeOf(transport.whenConnected());

    // When it waits twice the default deadline, then is answered
    await timers.advance(20_000);
    const offers = peer.find('handshakeOffer').length;
    answerHandshake();
    await timers.advance(0);

    // Then it kept offering and connects
    expect(offers).toBeGreaterThan(20_000 / RETRY_MS / 2);
    expect(await opened).toEqual({ value: undefined });
  });

  it('As an opener with no timeout set, my handshake waits 10 seconds for an answer, as host-api and truapi wait', async () => {
    // Given
    const { left } = createProviderPair();
    const timers = manualTimers();
    const transport = createTransport(testSchema, left, { handshake: 'offer', hello: 'opener', timers });
    let settled: unknown;
    void transport.whenConnected().catch((error: unknown) => {
      settled = error;
    });

    // When
    transport.connect();
    await timers.advance(9_999);

    // Then
    expect(settled).toBeUndefined();

    // When
    await timers.advance(1);

    // Then
    expect(settled).toBeInstanceOf(TransportHandshakeTimeoutError);
  });

  it('As an opener, a handshake answer after my handshake timed out changes nothing', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = rawRig('offer');
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
    const { transport, timers, peer } = rawRig('offer');
    transport.connect();
    const call = outcomeOf(transport.request(notes.touch, undefined));
    await timers.advance(0);
    const attempt = must(peer.heard[0], 'a handshake');

    // When
    peer.send(attempt.id, {
      tag: 'handshakeResponse',
      value: err({ wire: WIRE_VERSION, schema: VERSION + 1 }),
    });
    await timers.advance(0);

    // Then
    const failure = await outcomeOf(transport.whenConnected());
    expect(failure).toBeInstanceOf(TransportUnsupportedProtocolVersionError);
    expect(failure).toMatchObject({
      message: `The peer speaks schema version ${String(VERSION + 1)} and this side ${String(VERSION)}.`,
      ours: { wire: WIRE_VERSION, schema: VERSION },
      theirs: { wire: WIRE_VERSION, schema: VERSION + 1 },
    });
    expect(await call).toBe(failure);
    const heard = peer.heard.length;
    await timers.advance(RETRY_MS * 10);
    expect(peer.heard).toHaveLength(heard);
  });

  it('As an opener, every retry and flush posts a fresh buffer', async () => {
    // Given
    const { transport, timers, peer, left, answerHandshake } = rawRig('offer');
    const post = vi.spyOn(left, 'postMessage');
    const calls = [1, 2, 3].map(() => outcomeOf(transport.request(notes.touch, undefined)));

    // When
    transport.connect();
    await timers.advance(RETRY_MS * 3);
    answerHandshake();
    await transport.whenConnected();
    await timers.advance(0);

    // Then
    expect(peer.names()).toEqual([
      'handshakeOffer',
      'handshakeOffer',
      'handshakeOffer',
      'handshakeOffer',
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
      postMessage: () => {
        throw broken;
      },
    };
    const timers = manualTimers();
    const { issues, onIssue } = issueLog();
    const transport = createTransport(testSchema, provider, { handshake: 'offer', hello: 'opener', timers, onIssue });

    // When
    transport.connect();
    const outcome = outcomeOf(transport.whenConnected());
    await timers.advance(0);

    // Then
    expect(await outcome).toBe(broken);
    expect(issues).toEqual([{ kind: 'post_failed', error: broken }]);
  });

  it('As an opener, my first request, subscription or wait for the handshake starts it, as host-api starts it, and an accepter starts nothing', async () => {
    // Given three openers and an accepter, none of which connects
    const requesting = rawRig('offer');
    const subscribing = rawRig('offer');
    const waiting = rawRig('offer');
    const accepting = rawRig('respond');

    // When each calls
    void outcomeOf(requesting.transport.request(notes.touch, undefined));
    subscribing.transport.subscribe(notes.watch, 'from the top', watcher());
    void outcomeOf(waiting.transport.whenConnected());
    void outcomeOf(accepting.transport.request(notes.touch, undefined));
    accepting.transport.subscribe(notes.watch, 'from the top', watcher());
    void outcomeOf(accepting.transport.whenConnected());
    await Promise.all([requesting, subscribing, waiting, accepting].map(rig => rig.timers.advance(0)));

    // Then each opener offered its handshake, with the library's wire version first, and the accepter posted nothing
    for (const opener of [requesting, subscribing, waiting]) {
      expect(opener.peer.heard).toEqual([
        {
          id: 0,
          kind: 'handshakeOffer',
          value: { versions: { wire: WIRE_VERSION, schema: VERSION }, hello: str.enc('opener') },
        },
      ]);
    }
    expect(accepting.peer.heard).toEqual([]);
  });

  it('As an accepter, an opener of another wire version is refused with both my versions, and each side names the wire version that differs', async () => {
    // Given an opener on the next wire version that offers the handshake through a raw peer
    const { transport, timers, peer, openHandshake } = rawRig('respond');

    // When
    openHandshake(VERSION, 1, WIRE_VERSION + 1);
    await timers.advance(0);

    // Then
    expect(peer.handshakeResponses()).toEqual([{ id: 1, value: err({ wire: WIRE_VERSION, schema: VERSION }) }]);
    const failure = await outcomeOf(transport.whenConnected());
    expect(failure).toBeInstanceOf(TransportUnsupportedProtocolVersionError);
    expect(failure).toMatchObject({
      message: `The peer speaks wire version ${String(WIRE_VERSION + 1)} and this side ${String(WIRE_VERSION)}.`,
    });
  });

  it('As an opener, a peer whose wire and schema versions both differ fails my handshake naming both', async () => {
    // Given
    const { transport, timers, peer } = rawRig('offer');
    transport.connect();
    await timers.advance(0);
    const attempt = must(peer.heard[0], 'a handshake');

    // When
    peer.send(attempt.id, {
      tag: 'handshakeResponse',
      value: err({ wire: WIRE_VERSION + 1, schema: VERSION + 1 }),
    });
    await timers.advance(0);

    // Then
    expect(await outcomeOf(transport.whenConnected())).toMatchObject({
      name: 'TransportUnsupportedProtocolVersionError',
      message:
        `The peer speaks wire version ${String(WIRE_VERSION + 1)} and this side ${String(WIRE_VERSION)}. ` +
        `The peer speaks schema version ${String(VERSION + 1)} and this side ${String(VERSION)}.`,
    });
  });

  it('As an accepter, I answer every handshake attempt with the outcome of the first', async () => {
    // Given
    const { transport, timers, peer, openHandshake } = rawRig('respond');

    // When
    openHandshake(VERSION, 1);
    openHandshake(VERSION, 3);
    await timers.advance(0);

    // Then
    expect(peer.handshakeResponses()).toEqual([
      { id: 1, value: ok(str.enc('accepter')) },
      { id: 3, value: ok(str.enc('accepter')) },
    ]);
    await expect(transport.whenConnected()).resolves.toBeUndefined();
  });

  it('As an accepter, I refuse an attempt of another version and close with both versions, and a later attempt is refused with no answer', async () => {
    // Given
    const { transport, timers, peer, issues, openHandshake } = rawRig('respond');
    const call = outcomeOf(transport.request(notes.touch, undefined));

    // When
    openHandshake(VERSION + 1, 1);
    openHandshake(VERSION + 1, 3);
    await timers.advance(0);

    // Then
    expect(peer.handshakeResponses()).toEqual([{ id: 1, value: err({ wire: WIRE_VERSION, schema: VERSION }) }]);
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'invalid',
        cause: expect.objectContaining({
          message: expect.stringContaining('A handshake offer came after the transport closed') as string,
        }) as Error,
      },
    ]);
    const failure = await outcomeOf(transport.whenConnected());
    expect(failure).toBeInstanceOf(TransportUnsupportedProtocolVersionError);
    expect(failure).toMatchObject({
      message: `The peer speaks schema version ${String(VERSION + 1)} and this side ${String(VERSION)}.`,
    });
    expect(await call).toBe(failure);
    expect(peer.names()).not.toContain('request:notes.touch');
  });

  it('As an opener, a handshake answer before my handshake started is refused as invalid', async () => {
    // Given an opener that made no call
    const { transport, timers, peer, issues } = rawRig('offer');

    // When
    peer.send(1, { tag: 'handshakeResponse', value: ok(str.enc('peer')) });
    await timers.advance(0);

    // Then the answer settled nothing, so the handshake it then starts waits for an answer of its own
    expect(issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error }]);
    expect(peer.heard).toEqual([]);
    const connecting = transport.whenConnected();
    await timers.advance(0);
    expect(await Promise.race([connecting, Promise.resolve('still waiting')])).toBe('still waiting');
    expect(peer.names()).toEqual(['handshakeOffer']);
  });

  it('As an accepter, an answer I cannot post closes me with why, and the next attempt is refused with no answer', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = breakable(broken);
    const { transport, timers, peer, issues, openHandshake } = rawRig('respond', wrap);
    const call = outcomeOf(transport.request(notes.touch, undefined));
    breakPosts();

    // When
    openHandshake(VERSION, 1);
    await timers.advance(0);

    // Then
    expect(issues).toEqual([{ kind: 'post_failed', error: broken }]);
    expect(await outcomeOf(transport.whenConnected())).toBe(broken);
    expect(await call).toBe(broken);

    // When
    mendPosts();
    openHandshake(VERSION, 3);
    await timers.advance(0);

    // Then
    expect(issues).toHaveLength(2);
    expect(issues[1]).toMatchObject({ kind: 'refused', reason: 'invalid' });
    expect(peer.heard).toEqual([]);
  });

  it('As either side, a handshake leg meant for the other side is refused as invalid', async () => {
    // Given
    const opening = rawRig('offer');
    const accepting = rawRig('respond');

    // When
    opening.openHandshake();
    accepting.peer.send(1, { tag: 'handshakeResponse', value: ok(str.enc('peer')) });
    await opening.timers.advance(0);

    // Then
    expect(opening.issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error }]);
    expect(accepting.issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error }]);
    expect(opening.peer.heard).toEqual([]);
    expect(accepting.peer.heard).toEqual([]);
  });
});

/** A message on the method at `at` whose leg no method reads, as the frame body a raw side posts. */
const unreadableLeg = (at: AnyMethod) => {
  const { sectionId, methodId } = testSchema.addressOf(at);
  return { tag: 'call' as const, value: { sectionId, methodId, message: UNKNOWN_LEG } };
};

/**
 * A peer and the forwarder it opened to, whose upstream faces a raw server the test speaks for, both handshakes over.
 * `toPeer` is what the peer's channel delivered, both ways.
 */
async function forwardingToRaw() {
  const near = rig();
  const far = rawRig('offer');
  near.accepter.forward([notes.read, notes.watch, echo.say], far.transport);
  near.opener.connect();
  far.transport.connect();
  await near.timers.advance(0);
  far.answerHandshake();
  await far.transport.whenConnected();
  return { peer: near.opener, timers: near.timers, issues: near.issues, server: far.peer, toPeer: near.delivered };
}

/** A raw peer and its forwarder, whose upstream faces a server that answers `notes.read` once the test resolves it. */
async function forwardingFromRaw() {
  const near = rawRig('respond');
  const far = rig();
  const answer = deferred<ResultPayload<string, CallError<string>>>();
  const served = vi.fn(() => answer.promise);
  far.accepter.handleRequest(notes.read, served);
  near.transport.forward([notes.read, notes.watch], far.opener);
  near.openHandshake();
  await near.timers.advance(0);
  return { ...near, server: far.accepter, answer, served };
}

/** The id of the one call the raw server heard by `name`, such as `request:notes.read`. */
const heardId = (server: { find: (name: string) => { id: number }[] }, name: string): number =>
  must(server.find(name)[0], name).id;

describe('forwarding', () => {
  it('As a forwarder, I pass a request and its answer through, every byte of the message the same on both links', async () => {
    // Given
    const { peer, server, timers, issues, toForwarder, toUpstream } = forwardRig();
    server.handleRequest(notes.read, (key, { hello }) => ok(`${key}, read for the ${hello}`));

    // When
    const read = peer.request(notes.read, 'a note');
    await timers.advance(0);

    // Then
    expect(await read).toEqual(ok('a note, read for the upstream'));
    const request = [toHex(notes.read.message.enc({ tag: 'request', value: 'a note' }))];
    const response = [toHex(notes.read.message.enc({ tag: 'response', value: ok('a note, read for the upstream') }))];
    expect(messageHex(toForwarder, 'request:notes.read')).toEqual(request);
    expect(messageHex(toUpstream, 'request:notes.read')).toEqual(request);
    expect(messageHex(toUpstream, 'response:notes.read')).toEqual(response);
    expect(messageHex(toForwarder, 'response:notes.read')).toEqual(response);
    expect(issues).toEqual([]);
  });

  it("As a forwarder, I pass the upstream's failure back as a failed frame on the peer's call", async () => {
    // Given a server with no handler for the method
    const { peer, timers, issues, toForwarder, toUpstream } = forwardRig();

    // When
    const said = peer.request(echo.say, 'hello');
    await timers.advance(0);

    // Then
    expect(await said).toEqual(err(unsupported()));
    expect(namesOf(toUpstream)).toEqual(['handshakeOffer', 'handshakeResponse', 'request:echo.say', 'failed']);
    expect(namesOf(toForwarder)).toEqual(['handshakeOffer', 'handshakeResponse', 'request:echo.say', 'failed']);
    expect(issues).toEqual([]);
  });

  it("As a forwarder, I pass a subscription's values and its interrupt through, and the peer's stop reaches the upstream", async () => {
    // Given
    const { peer, server, timers, issues, toForwarder, toUpstream } = forwardRig();
    const { starts, sinks, stops } = serveWatch(server);
    const heard = watcher();
    peer.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);

    // When the server sends a value and ends it
    must(sinks[0], 'the first sink').send('first');
    must(sinks[0], 'the first sink').interrupt(ok());
    await timers.advance(0);

    // Then
    expect(starts).toEqual(['from the top']);
    expect(heard.values).toEqual(['first']);
    expect(heard.ends).toEqual([ok()]);
    for (const [name, message] of [
      ['start:notes.watch', toHex(notes.watch.message.enc({ tag: 'start', value: 'from the top' }))],
      ['receive:notes.watch', toHex(notes.watch.message.enc({ tag: 'receive', value: 'first' }))],
      ['interrupt:notes.watch', toHex(notes.watch.message.enc({ tag: 'interrupt', value: ok() }))],
    ] as const) {
      expect(messageHex(toForwarder, name)).toEqual([message]);
      expect(messageHex(toUpstream, name)).toEqual([message]);
    }

    // When the peer stops a second one
    const unsubscribe = peer.subscribe(notes.watch, 'again', watcher());
    await timers.advance(0);
    unsubscribe();
    await timers.advance(0);

    // Then
    expect(stops).toEqual([1, 1]);
    const stop = [toHex(notes.watch.message.enc({ tag: 'stop', value: undefined }))];
    expect(messageHex(toForwarder, 'stop:notes.watch')).toEqual(stop);
    expect(messageHex(toUpstream, 'stop:notes.watch')).toEqual(stop);
    expect(issues).toEqual([]);
  });

  it('As a forwarder, I decode no payload in the middle', async () => {
    // Given
    const { schema, decodes } = countedSchema();
    const { read, watch } = schema.sections.notes;
    const { peer, server, timers, issues } = forwardRig(schema);
    server.handleRequest(read, key => ok(key));
    server.handleSubscription(watch, (start, _context, sink) => {
      sink.send(start);
      sink.send('second');
      return () => undefined;
    });

    // When
    const answered = peer.request(read, 'a note');
    await timers.advance(0);

    // Then the server decoded the request and the peer the response
    expect(await answered).toEqual(ok('a note'));
    expect(decodes()).toBe(2);

    // When
    const heard = watcher();
    peer.subscribe(watch, 'first', heard);
    await timers.advance(0);

    // Then the server decoded the start and the peer each value
    expect(heard.values).toEqual(['first', 'second']);
    expect(decodes()).toBe(5);
    expect(issues).toEqual([]);
  });

  it('As a forwarder, I answer each forwarded call HostFailure when the upstream closes under it', async () => {
    // Given
    const { peer, upstream, server, timers, issues } = forwardRig();
    server.handleRequest(notes.read, () => deferred<ResultPayload<string, CallError<string>>>().promise);
    serveWatch(server);
    const read = peer.request(notes.read, 'a note');
    const heard = watcher();
    peer.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);

    // When
    upstream.dispose(new Error('gone'));
    await timers.advance(0);

    // Then
    expect(await read).toEqual(err(hostFailure(new Error('gone'))));
    expect(heard.fails).toEqual([hostFailure(new Error('gone'))]);
    expect(issues).toEqual([]);
  });

  it('As a forwarder that closes, I post nothing to my peer and stop each forwarded subscription on the upstream', async () => {
    // Given
    const { peer, forwarder, server, timers, issues, toForwarder, toUpstream } = forwardRig();
    const answer = deferred<ResultPayload<string, CallError<string>>>();
    server.handleRequest(notes.read, () => answer.promise);
    const { stops } = serveWatch(server);
    void peer.request(notes.read, 'a note');
    const heard = watcher();
    peer.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);
    const posted = toForwarder.length;

    // When
    forwarder.dispose(new Error('closing'));
    await timers.advance(0);
    answer.resolve(ok('too late'));
    await timers.advance(0);

    // Then the late answer is dropped on the upstream, and the peer hears nothing
    expect(stops).toEqual([1]);
    expect(messageHex(toUpstream, 'stop:notes.watch')).toEqual([
      toHex(notes.watch.message.enc({ tag: 'stop', value: undefined })),
    ]);
    expect(messageHex(toUpstream, 'response:notes.read')).toEqual([
      toHex(notes.read.message.enc({ tag: 'response', value: ok('too late') })),
    ]);
    expect(toForwarder).toHaveLength(posted);
    expect([heard.values, heard.ends, heard.fails, heard.closes]).toEqual([[], [], [], []]);
    expect(issues).toEqual([]);
  });

  it("As a forwarder, I refuse an unreadable message that reuses an in-flight request id and the peer hears only the upstream's answer", async () => {
    // Given a forwarded request in flight on id 1
    const { peer, timers, issues, answer } = await forwardingFromRaw();
    peer.call(notes.read, 1, { tag: 'request', value: 'a note' });
    await timers.advance(0);

    // When
    peer.send(1, unreadableLeg(notes.read));
    await timers.advance(0);

    // Then
    const reused = new Error('A request reuses call 1, which is still in flight');
    expect(issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: reused }]);
    expect(peer.names()).toEqual(['handshakeResponse']);

    // When
    answer.resolve(ok('the note'));
    await timers.advance(0);

    // Then
    expect(peer.names()).toEqual(['handshakeResponse', 'response:notes.read']);
    expect(peer.values(notes.read, 'response:notes.read')).toEqual([ok('the note')]);
  });

  it('As a forwarder, I refuse a request that reuses an in-flight id and the upstream serves it once', async () => {
    // Given a forwarded request in flight on id 1
    const { peer, timers, issues, answer, served } = await forwardingFromRaw();
    peer.call(notes.read, 1, { tag: 'request', value: 'a note' });
    await timers.advance(0);

    // When
    peer.call(notes.read, 1, { tag: 'request', value: 'the same note again' });
    await timers.advance(0);
    answer.resolve(ok('the note'));
    await timers.advance(0);

    // Then
    expect(served).toHaveBeenCalledOnce();
    const reused = new Error('A request reuses call 1, which is still in flight');
    expect(issues).toEqual([{ kind: 'refused', reason: 'invalid', cause: reused }]);
    expect(peer.names()).toEqual(['handshakeResponse', 'response:notes.read']);
    expect(peer.values(notes.read, 'response:notes.read')).toEqual([ok('the note')]);
  });

  it('As a forwarder, I refuse a stop with trailing bytes and the subscription keeps running on both links until a whole stop ends it', async () => {
    // Given a forwarded subscription on id 1
    const { peer, timers, issues, server } = await forwardingFromRaw();
    const { sinks, stops } = serveWatch(server);
    peer.call(notes.watch, 1, { tag: 'start', value: 'from the top' });
    await timers.advance(0);
    const { sectionId, methodId } = testSchema.addressOf(notes.watch);

    // When
    peer.send(1, { tag: 'call', value: { sectionId, methodId, message: TRAILED_STOP } });
    await timers.advance(0);
    must(sinks[0], 'the sink').send('still here');
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      {
        kind: 'refused',
        reason: 'malformed',
        cause: expect.objectContaining({ message: 'The value is followed by unread bytes, 1 in all' }) as Error,
      },
    ]);
    expect(stops).toEqual([0]);
    expect(peer.values(notes.watch, 'receive:notes.watch')).toEqual(['still here']);
    expect(peer.failures()).toEqual([]);

    // When
    peer.call(notes.watch, 1, { tag: 'stop', value: undefined });
    await timers.advance(0);

    // Then
    expect(stops).toEqual([1]);
    expect(issues).toHaveLength(1);
  });

  it('As a forwarder, I replace a forwarded subscription on a reused start and stop the old one on the upstream', async () => {
    // Given a raw peer, and a server behind the upstream
    const near = rawRig('respond');
    const far = rig();
    const { starts, sinks, stops } = serveWatch(far.accepter);
    near.transport.forward([notes.watch], far.opener);
    near.openHandshake();
    await near.timers.advance(0);
    near.peer.call(notes.watch, 1, { tag: 'start', value: 'first' });
    await far.timers.advance(0);

    // When
    near.peer.call(notes.watch, 1, { tag: 'start', value: 'second' });
    await far.timers.advance(0);
    must(sinks[1], 'the second sink').send('fresh');
    await far.timers.advance(0);

    // Then
    expect(starts).toEqual(['first', 'second']);
    expect(stops).toEqual([1, 0]);
    expect(near.peer.values(notes.watch, 'receive:notes.watch')).toEqual(['fresh']);
    expect([...near.issues, ...far.issues]).toEqual([]);
  });

  it("As a forwarder, I start the upstream's handshake with the first forwarded call and send it once the handshake is over", async () => {
    // Given
    const { peer, server, timers, issues, toUpstream } = forwardRig();
    server.handleRequest(echo.say, text => ok(text));
    peer.connect();
    await timers.advance(0);
    expect(toUpstream).toEqual([]);

    // When
    const said = peer.request(echo.say, 'hello');
    await timers.advance(0);

    // Then
    expect(await said).toEqual(ok('hello'));
    expect(namesOf(toUpstream)).toEqual([
      'handshakeOffer',
      'handshakeResponse',
      'request:echo.say',
      'response:echo.say',
    ]);
    expect(issues).toEqual([]);
  });

  it('As a forwarder, I end a subscription stopped while its start waits for the upstream and post nothing upstream', async () => {
    // Given a raw peer, and a raw server behind the upstream that has not answered the handshake
    const near = rawRig('respond');
    const far = rawRig('offer');
    near.transport.forward([notes.watch], far.transport);
    near.openHandshake();
    await near.timers.advance(0);
    near.peer.call(notes.watch, 1, { tag: 'start', value: 'from the top' });
    await near.timers.advance(0);

    // When
    near.peer.call(notes.watch, 1, { tag: 'stop', value: undefined });
    await near.timers.advance(0);
    far.answerHandshake();
    await far.transport.whenConnected();
    await far.timers.advance(0);

    // Then the late handshake opens nothing
    expect(far.peer.names()).toEqual(['handshakeOffer']);
    expect(near.peer.names()).toEqual(['handshakeResponse']);
    expect([...near.issues, ...far.issues]).toEqual([]);
  });

  it('As a forwarder, I stop forwarding a method and new calls of it are Unsupported while open ones run to their end', async () => {
    // Given
    const { peer, server, timers, issues, stopForwarding } = forwardRig();
    const answer = deferred<ResultPayload<string, CallError<string>>>();
    server.handleRequest(notes.read, () => answer.promise);
    const { sinks, stops } = serveWatch(server);
    const read = peer.request(notes.read, 'a note');
    const heard = watcher();
    const unsubscribe = peer.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);

    // When
    stopForwarding();
    const refused = peer.request(notes.read, 'another note');
    answer.resolve(ok('the note'));
    must(sinks[0], 'the first sink').send('still here');
    await timers.advance(0);
    unsubscribe();
    await timers.advance(0);

    // Then
    expect(await refused).toEqual(err(unsupported()));
    expect(await read).toEqual(ok('the note'));
    expect(heard.values).toEqual(['still here']);
    expect(stops).toEqual([1]);
    expect(issues).toEqual([]);
  });

  it('As a forwarder, I pass a 1 MB message through and every byte is the same on both links', async () => {
    // Given
    const { peer, server, timers, issues, toForwarder, toUpstream } = forwardRig();
    server.handleRequest(echo.say, text => ok(text));
    const text = 'a 1 MB note'.repeat(100_000).slice(0, 1_000_000);

    // When
    const said = peer.request(echo.say, text);
    await timers.advance(0);

    // Then
    expect(await said).toEqual(ok(text));
    const request = [toHex(echo.say.message.enc({ tag: 'request', value: text }))];
    const response = [toHex(echo.say.message.enc({ tag: 'response', value: ok(text) }))];
    expect(messageHex(toForwarder, 'request:echo.say')).toEqual(request);
    expect(messageHex(toUpstream, 'request:echo.say')).toEqual(request);
    expect(messageHex(toUpstream, 'response:echo.say')).toEqual(response);
    expect(messageHex(toForwarder, 'response:echo.say')).toEqual(response);
    expect(issues).toEqual([]);
  });

  it("As a forwarder, I pass the upstream's failed frame on a subscription back and the peer's fail hears it", async () => {
    // Given a server whose handler throws on start
    const { peer, server, timers, issues } = forwardRig();
    server.handleSubscription(notes.watch, () => {
      throw new RangeError('no watching today');
    });
    const heard = watcher();

    // When
    peer.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);

    // Then
    expect(heard.fails).toEqual([hostFailure('RangeError: no watching today')]);
    expect([heard.values, heard.ends, heard.closes]).toEqual([[], [], []]);
    expect(issues).toEqual([]);
  });

  it('As a forwarder, I pass an unreadable value through and the peer refuses it and stops it on the upstream', async () => {
    // Given
    const { peer, timers, issues, server } = await forwardingToRaw();
    const heard = watcher();
    peer.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);
    const id = heardId(server, 'start:notes.watch');

    // When
    server.send(id, unreadableLeg(notes.watch));
    await timers.advance(0);

    // Then the peer refuses it as a lost value and tells the server to stop
    expect(heard.fails).toEqual([expect.objectContaining({ tag: 'MalformedFrame' }) as Failure]);
    expect(server.find('stop:notes.watch').map(stop => stop.id)).toEqual([id]);
    expect(issues).toEqual([{ kind: 'refused', reason: 'malformed', cause: expect.any(Error) as Error }]);
  });

  it('As a forwarder, I pass back an answer whose leg cannot be read and the peer rejects it as malformed', async () => {
    // Given
    const { peer, timers, issues, server } = await forwardingToRaw();
    const read = outcomeOf(peer.request(notes.read, 'a note'));
    await timers.advance(0);

    // When
    server.send(heardId(server, 'request:notes.read'), unreadableLeg(notes.read));
    await timers.advance(0);

    // Then
    expect(await read).toBeInstanceOf(TransportMalformedResponseError);
    expect(issues).toEqual([{ kind: 'refused', reason: 'malformed', cause: expect.any(Error) as Error }]);
  });

  it("As a forwarder, I answer HostFailure for a call still waiting on the upstream's handshake when it times out", async () => {
    // Given an upstream whose server never answers the handshake
    const near = rig();
    const far = rawRig('offer');
    near.accepter.forward([notes.read], far.transport);
    near.opener.connect();
    await near.timers.advance(0);
    const read = near.opener.request(notes.read, 'a note');
    await near.timers.advance(0);

    // When
    await far.timers.advance(TIMEOUT_MS);

    // Then
    const timedOut = new TransportHandshakeTimeoutError(`No handshake answer within ${String(TIMEOUT_MS)} ms`);
    expect(await read).toEqual(err(hostFailure(timedOut)));
    expect(far.peer.names().filter(name => name !== 'handshakeOffer')).toEqual([]);
    expect(near.issues).toEqual([]);
  });

  it('As a forwarder, I answer a peer message whose leg cannot be read MalformedFrame and forward nothing', async () => {
    // Given
    const near = rawRig('respond');
    const far = rig();
    near.transport.forward([notes.read], far.opener);
    near.openHandshake();
    await near.timers.advance(0);

    // When
    near.peer.send(1, unreadableLeg(notes.read));
    await near.timers.advance(0);

    // Then
    expect(near.peer.failures()).toEqual([
      { id: 1, value: expect.objectContaining({ tag: 'MalformedFrame' }) as Failure },
    ]);
    expect(near.issues).toEqual([{ kind: 'refused', reason: 'malformed', cause: expect.any(Error) as Error }]);
    expect(far.delivered).toEqual([]);
  });

  it('As a forwarder, I refuse a response or a value the peer sends on a forwarded method and forward neither', async () => {
    // Given
    const near = rawRig('respond');
    const far = rig();
    const { starts, stops } = serveWatch(far.accepter);
    near.transport.forward([notes.read, notes.watch], far.opener);
    near.openHandshake();
    await near.timers.advance(0);
    near.peer.call(notes.watch, 3, { tag: 'start', value: 'from the top' });
    await far.timers.advance(0);

    // When
    near.peer.call(notes.read, 1, { tag: 'response', value: ok('not asked') });
    near.peer.call(notes.watch, 3, { tag: 'receive', value: 'backwards' });
    await far.timers.advance(0);

    // Then
    const invalid = { kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error };
    expect(near.issues).toEqual([invalid, invalid]);
    expect(namesOf(far.delivered)).toEqual(['handshakeOffer', 'handshakeResponse', 'start:notes.watch']);
    expect([starts, stops]).toEqual([['from the top'], [0]]);
    expect(near.peer.names()).toEqual(['handshakeResponse']);
  });

  it('As a forwarder, I refuse the wrong legs the upstream sends on forwarded calls and pass none back', async () => {
    // Given
    const { peer, timers, issues, server, toPeer } = await forwardingToRaw();
    const read = peer.request(notes.read, 'a note');
    const heard = watcher();
    peer.subscribe(notes.watch, 'from the top', heard);
    await timers.advance(0);
    const readId = heardId(server, 'request:notes.read');
    const watchId = heardId(server, 'start:notes.watch');

    // When the server sends the wrong legs, then the right ones
    server.call(notes.read, readId, { tag: 'request', value: 'backwards' });
    server.call(notes.watch, watchId, { tag: 'start', value: 'backwards' });
    server.call(notes.watch, watchId, { tag: 'stop', value: undefined });
    await timers.advance(0);
    server.call(notes.read, readId, { tag: 'response', value: ok('the note') });
    server.call(notes.watch, watchId, { tag: 'receive', value: 'a value' });
    await timers.advance(0);

    // Then only the right ones reach the peer
    const invalid = { kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error };
    expect(issues).toEqual([invalid, invalid, invalid]);
    expect(await read).toEqual(ok('the note'));
    expect(heard.values).toEqual(['a value']);
    expect([heard.ends, heard.fails, heard.closes]).toEqual([[], [], []]);
    expect(namesOf(toPeer)).toEqual([
      'handshakeOffer',
      'handshakeResponse',
      'request:notes.read',
      'start:notes.watch',
      'response:notes.read',
      'receive:notes.watch',
    ]);
  });

  it('As a forwarder, I drop a stop with no subscription running under its id and forward nothing', async () => {
    // Given
    const near = rawRig('respond');
    const far = rig();
    serveWatch(far.accepter);
    near.transport.forward([notes.watch], far.opener);
    near.openHandshake();
    await near.timers.advance(0);

    // When
    near.peer.call(notes.watch, 1, { tag: 'stop', value: undefined });
    await near.timers.advance(0);

    // Then
    expect(far.delivered).toEqual([]);
    expect(near.peer.names()).toEqual(['handshakeResponse']);
    expect([...near.issues, ...far.issues]).toEqual([]);
  });

  it('As a schema user, I am refused forwarding to a transport that places the method elsewhere, to one this library did not build, or for a method that already has a handler', () => {
    // Given
    const { forwarder, upstream } = forwardRig();
    const reordered = defineSchema({ version: VERSION, hello: str, sections: { echo, notes } });
    const elsewhere = createTransport(reordered, createProviderPair().left, { handshake: 'offer', hello: 'elsewhere' });

    // When
    const toElsewhere = () => forwarder.forward([notes.touch], elsewhere);
    const toAnother = () => forwarder.forward([notes.touch], { ...upstream });
    const twice = () => forwarder.forward([notes.touch, notes.read], upstream);

    // Then nothing a refused call names stays forwarded
    expect(toElsewhere).toThrow('notes.touch sits elsewhere in the upstream');
    expect(toAnother).toThrow('The upstream transport was not built by this library');
    expect(twice).toThrow('notes.read already has a handler');
    expect(() => forwarder.handleRequest(notes.touch, () => ok())).not.toThrow();
  });
});
