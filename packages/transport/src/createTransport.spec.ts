// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { type ResultPayload, _void, str } from 'scale-ts';
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest';
import { createDeferred, toHex } from '@dotli/shared';
import { catchError, createManualTimers, must, recordLog } from '@dotli/shared/testing';
import { domain, type CallError } from './callError.js';
import { codec } from './codec.js';
import { WIRE_VERSION } from './constants.js';
import { createTransport, type Transport, type TransportParams } from './createTransport.js';
import { defineSchema, type Sections } from './defineSchema.js';
import type { TransportIssue } from './describeIssue.js';
import { cancelled, denied, hostFailure, malformedFrame, unsupported, type Failure } from './failure.js';
import { frameCodec } from './frame.js';
import { toMessageBytes } from './messageBytes.js';
import type { AnyMethod } from './method.js';
import { createProviderPair } from './provider.fake.js';
import type { Provider } from './provider.js';
import { err, ok } from './result.js';
import { captureOutcome } from './testing/captureOutcome.js';
import {
  matchAnyString,
  matchFields,
  matchInstance,
  matchRefusedIssue,
  matchStringContaining,
} from './testing/matchers.js';
import {
  CUT_SHORT_TEXT,
  RETRY_MS,
  TIMEOUT_MS,
  TRAILED_REASON,
  TRAILED_TEXT,
  UNKNOWN_LEG,
  VERSION,
} from './testing/constants.js';
import { createBreakablePosts } from './testing/createBreakablePosts.js';
import { createCountedSchema } from './testing/createCountedSchema.js';
import { createForwardRig } from './testing/createForwardRig.js';
import { createIssueLog } from './testing/createIssueLog.js';
import { createRawRig, type RawRigParams } from './testing/createRawRig.js';
import { createRig } from './testing/createRig.js';
import { createWatcher } from './testing/createWatcher.js';
import { getFrameNames } from './testing/getFrameNames.js';
import { getMessageHex } from './testing/getMessageHex.js';
import { rawRead, rawWatch } from './testing/rawMethods.js';
import { serveWatch } from './testing/serveWatch.js';
import { echo, notes, NOTES, testSchema, TRAILED_STOP } from './testing/testSchema.js';
import { TransportHandshakeTimeoutError } from './transportHandshakeTimeoutError.js';
import { TransportMalformedResponseError } from './transportMalformedResponseError.js';
import { TransportUnsupportedProtocolVersionError } from './transportUnsupportedProtocolVersionError.js';
import type { Sink } from './createServedCalls.js';
import type { CallContext } from './types.js';

/** A peer the test speaks for, frame by frame, in place of a transport. */
type RawPeer = ReturnType<typeof createRawRig>['peer'];

describe('createTransport', () => {
  it('As a schema author, I pass a method and my calls and handlers are typed by it', () => {
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
      const unsubscribe = transport.subscribe({
        method: notes.watch,
        start: 'from the top',
        listeners: {
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
        },
      });
      expectTypeOf(unsubscribe).toEqualTypeOf<() => void>();
      // @ts-expect-error a request is not a subscription
      transport.subscribe({ method: notes.read, start: 'a note', listeners: createWatcher() });
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
    type Options = Omit<TransportParams<string, Sections>, 'schema' | 'provider'>;
    expectTypeOf<{ handshake: 'offer'; hello: string }>().toExtend<Options>();
    expectTypeOf<{ handshake: 'offer' }>().not.toExtend<Options>();
    expect(typeOnly).toBeTypeOf('function');
  });

  it('As a peer, I serve and call over the same transport, and both directions work at once', async () => {
    // Given
    const { opener, accepter, timers, issues } = createRig();
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

  it('As a receiver whose schema throws, I hear a message and the throw is reported and never reaches the provider', () => {
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
    const { issues, onIssue } = createIssueLog();
    const transport = createTransport({ schema, provider, handshake: 'respond', hello: 'accepter', onIssue });
    transport.handleRequest(notes.touch, () => ok());
    const hear = (message: Uint8Array): void => {
      for (const callback of callbacks) {
        callback(message);
      }
    };
    hear(
      frameCodec.enc({
        id: 1,
        body: {
          tag: 'handshakeOffer',
          value: { versions: { wire: WIRE_VERSION, schema: VERSION }, hello: str.enc('peer') },
        },
      }),
    );

    // When
    const thrown = catchError(() => {
      const message = { tag: 'request' as const, value: undefined };
      hear(notes.touch.frame.enc({ id: 3, body: { tag: 'call', value: { sectionId: 0, methodId: 1, message } } }));
    });

    // Then
    expect(thrown).toBeUndefined();
    expect(issues).toEqual([
      matchRefusedIssue('invalid', matchFields<Error>({ message: 'The message could not be handled', cause: bug })),
    ]);
  });

  it('As an owner whose issue hook throws, I hear a malformed message and the issue and the throw are logged, never reaching the provider', () => {
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
    createTransport({
      schema: testSchema,
      provider,
      handshake: 'respond',
      hello: 'accepter',
      onIssue: () => {
        throw new Error('hook bug');
      },
    });

    // When
    const thrown = catchError(() => {
      for (const callback of callbacks) {
        callback(Uint8Array.of(0xff, 0xff, 0xff));
      }
    });

    // Then
    expect(thrown).toBeUndefined();
    expect(errors.map(line => line.message)).toEqual([
      '[transport] A message was refused as malformed, RangeError: Offset is outside the bounds of the DataView',
      '[transport] A listener threw, Error: The issue hook threw, Error: hook bug',
    ]);
  });

  it('As an owner with no issue hook, I hit issues and each is logged as one bounded error', async () => {
    // Given
    const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
    const { left, right } = createProviderPair();
    const timers = createManualTimers();
    const opener = createTransport({
      schema: testSchema,
      provider: {
        ...left,
        postMessage: () => {
          throw new Error('x'.repeat(1_000));
        },
      },
      handshake: 'offer',
      hello: 'opener',
      timers,
    });

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

  it('As an owner, I dispose and the provider is released, and a later connect posts nothing', async () => {
    // Given
    const { left } = createProviderPair();
    const timers = createManualTimers();
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
    const transport = createTransport({ schema: testSchema, provider, handshake: 'offer', hello: 'opener', timers });

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

  it('As an owner, I dispose and nothing is posted, no failure for a call I serve and no stop for a subscription I made, as truapi posts none', async () => {
    // Given a call and a subscription the peer made, and a subscription this side made
    const { transport, timers, peer } = await acceptRawRig();
    transport.handleRequest(notes.touch, () => new Promise(() => undefined));
    const { stops } = serveWatch(transport);
    peer.call({ method: notes.touch, id: 3, message: { tag: 'request', value: undefined } });
    peer.call({ method: notes.watch, id: 5, message: { tag: 'start', value: 'from the top' } });
    const heard = createWatcher();
    transport.subscribe({ method: notes.watch, start: 'mine', listeners: heard });
    await timers.advance(0);
    const posted = peer.getNames();

    // When
    const reason = new Error('the page is closing');
    transport.dispose(reason);
    await timers.advance(0);

    // Then the peer heard nothing more, and each side's own end still settled here
    expect(posted).toEqual(['handshakeResponse', 'start:notes.watch']);
    expect(peer.getNames()).toEqual(posted);
    expect(stops).toEqual([1]);
    expect(heard.closes).toEqual([reason]);
  });

  it('As an owner, I use a provider not in a correct environment and my transport closes at once with nothing posted', async () => {
    // Given
    const { left } = createProviderPair();
    const timers = createManualTimers();
    const post = vi.fn();
    const provider: Provider = { ...left, isCorrectEnvironment: () => false, postMessage: post };

    // When
    const transport = createTransport({ schema: testSchema, provider, handshake: 'offer', hello: 'opener', timers });
    transport.connect();
    const heard = createWatcher();
    transport.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
    const call = captureOutcome(transport.request(notes.touch, undefined));
    await timers.advance(1_000);
    const connecting = captureOutcome(transport.whenConnected());

    // Then
    const closed = matchFields<Error>({ message: 'Environment is not correct' });
    expect(await call).toEqual(closed);
    expect(await connecting).toEqual(closed);
    expect(heard.closes).toEqual([closed]);
    expect(heard.ends).toEqual([]);
    expect(heard.fails).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('calls', () => {
  it("As a caller, I call and my call resolves to the handler's Result, a domain error included", async () => {
    // Given
    const { opener, accepter, timers } = createRig();
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

  it('As a caller, I hear the peer fail my call as Unsupported and my call resolves Unsupported', async () => {
    // Given
    const { transport, timers, peer } = await connectRawRig();
    const call = transport.request(notes.read, 'note');
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');

    // When
    peer.send(asked.id, { tag: 'failed', value: unsupported() });
    await timers.advance(0);

    // Then
    expect(await call).toEqual(err(unsupported()));
  });

  it('As a caller, I hear an answer that names another method than my call and it is refused as invalid while my call waits on', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectRawRig();
    const call = transport.request(notes.read, 'note');
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');

    // When
    peer.call({ method: notes.touch, id: asked.id, message: { tag: 'response', value: ok() } });
    await timers.advance(0);
    peer.call({ method: notes.read, id: asked.id, message: { tag: 'response', value: ok('the note') } });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([matchRefusedIssue('invalid')]);
    expect(await call).toEqual(ok('the note'));
  });

  it('As a caller, I abort my open call and it resolves Cancelled, and a late answer is ignored', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectRawRig();
    const giveUp = new AbortController();
    const detach = vi.spyOn(giveUp.signal, 'removeEventListener');
    const call = transport.request(notes.read, 'note', { signal: giveUp.signal });
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');

    // When
    giveUp.abort(new Error('the budget ran out'));
    peer.call({ method: notes.read, id: asked.id, message: { tag: 'response', value: ok('late') } });
    peer.call({ method: notes.read, id: asked.id, message: { tag: 'response', value: ok('late') } });
    await timers.advance(0);

    // Then
    expect(await call).toEqual(err(cancelled()));
    expect(issues).toEqual([]);
    expect(peer.getNames()).toEqual(['handshakeOffer', 'request:notes.read']);
    expect(detach).toHaveBeenCalledOnce();

    // When the transport is disposed
    transport.dispose(new Error('done'));

    // Then the settled call detaches nothing more, where one still waiting would be settled again and detach twice
    expect(detach).toHaveBeenCalledOnce();
  });

  it('As a caller, I abort a queued call and it settles once as Cancelled and never posts, even when the handshake then fails', async () => {
    // Given
    const { transport, timers, peer } = createRawRig({ handshake: 'offer' });
    const giveUp = new AbortController();
    const call = captureOutcome(transport.request(notes.touch, undefined, { signal: giveUp.signal }));
    transport.connect();
    await timers.advance(0);

    // When
    giveUp.abort();
    await timers.advance(TIMEOUT_MS);
    const connecting = captureOutcome(transport.whenConnected());

    // Then
    expect(await connecting).toBeInstanceOf(TransportHandshakeTimeoutError);
    expect(await call).toEqual({ value: err(cancelled()) });
    expect(new Set(peer.getNames())).toEqual(new Set(['handshakeOffer']));
  });

  it('As a caller, I abort a queued call and it never goes out once the handshake succeeds', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = createRawRig({ handshake: 'offer' });
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
    expect(peer.getNames()).toEqual(['handshakeOffer']);
  });

  it('As a caller, I call with an already aborted signal and the call resolves Cancelled at once and posts nothing', async () => {
    // Given
    const { transport, timers, peer } = await connectRawRig();

    // When
    const call = transport.request(notes.touch, undefined, { signal: AbortSignal.abort() });

    // Then a marker settled after the call loses the race, so the call settled before any queue step
    expect(await Promise.race([call, Promise.resolve('still waiting')])).toEqual(err(cancelled()));

    // When the queue runs
    await timers.advance(0);

    // Then
    expect(peer.getNames()).toEqual(['handshakeOffer']);
  });

  it('As a caller, I hear an answer that does not decode and my call rejects with TransportMalformedResponseError, and it is reported', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectRawRig();
    const call = captureOutcome(transport.request(notes.read, 'note'));
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');

    // When an Ok answer to the call carries text that is cut short
    peer.call({
      method: rawRead,
      id: asked.id,
      message: { tag: 'response', value: ok(CUT_SHORT_TEXT) },
      at: notes.read,
    });
    await timers.advance(0);

    // Then the call rejects with why it does not decode as its cause
    const rejected = await call;
    expect(rejected).toBeInstanceOf(TransportMalformedResponseError);
    expect(rejected).toMatchObject({
      message: 'The answer to notes.read does not decode, RangeError: Invalid DataView length 2',
      cause: matchInstance(RangeError),
    });
    expect(issues).toEqual([matchRefusedIssue('malformed', matchInstance(RangeError))]);
  });

  it('As a caller, I hear an answer whose outcome is neither success nor failure and my call fails as malformed', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectRawRig();
    const call = captureOutcome(transport.request(notes.read, 'note'));
    await timers.advance(0);
    const asked = must(peer.find('request:notes.read')[0], 'the call');

    // When the answer's outcome tag is 2, sent as a receive, whose leg index is the response's
    peer.call({
      method: rawWatch,
      id: asked.id,
      message: { tag: 'receive', value: Uint8Array.of(2, 1) },
      at: notes.read,
    });
    await timers.advance(0);

    // Then
    expect(await call).toBeInstanceOf(TransportMalformedResponseError);
    expect(issues).toEqual([matchRefusedIssue('malformed')]);
  });

  it('As a caller, I hear an answer and a failure that leave bytes unread and both are refused as malformed, as truapi refuses them', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectRawRig();
    const answered = captureOutcome(transport.request(notes.read, 'note'));
    const failed = captureOutcome(transport.request(notes.read, 'other'));
    await timers.advance(0);
    const [first, second] = peer.find('request:notes.read').map(message => message.id);
    let settled = false;
    void failed.then(() => {
      settled = true;
    });

    // When one answer carries text with a byte after it, and a failure frame of the other has a byte after it
    peer.call({
      method: rawRead,
      id: must(first, 'the first call'),
      message: { tag: 'response', value: ok(TRAILED_TEXT) },
      at: notes.read,
    });
    peer.sendBytes(
      ...frameCodec.enc({ id: must(second, 'the second call'), body: { tag: 'failed', value: denied() } }),
      0,
    );
    await timers.advance(0);
    // A second turn gives the call of the refused failure time to settle, which it must not.
    await timers.advance(0);

    // Then the answer rejects as malformed, and the frame is refused while its call waits on
    expect(await answered).toMatchObject({
      name: 'TransportMalformedResponseError',
      message: `The answer to notes.read does not decode, ${TRAILED_REASON}`,
    });
    expect(issues).toEqual([
      matchRefusedIssue('malformed', matchInstance(RangeError)),
      matchRefusedIssue('malformed', matchInstance(RangeError)),
    ]);
    expect(settled).toBe(false);
  });

  it('As a caller, I call with a payload that cannot be encoded and my call rejects and posts nothing', async () => {
    // Given
    const { opener, accepter, timers, delivered } = createRig();
    accepter.handleRequest(notes.touch, () => ok());

    // When a bad and a good call are queued before the handshake
    const queuedBad = captureOutcome(opener.request(notes.read, ''));
    const queuedGood = opener.request(notes.touch, undefined);
    opener.connect();
    await timers.advance(0);

    // Then only the bad one rejects
    expect(await queuedBad).toBeInstanceOf(RangeError);
    expect(await queuedGood).toEqual(ok());

    // When a bad call is made once connected
    const posted = delivered.length;
    const bad = captureOutcome(opener.request(notes.read, ''));
    await timers.advance(0);

    // Then
    expect(await bad).toBeInstanceOf(RangeError);
    expect(delivered).toHaveLength(posted);
  });

  it('As a caller, I call while my provider cannot post and my call rejects with why, the post is reported, and my transport closes with it, as truapi closes', async () => {
    // Given an open subscription and a call the peer holds
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = createBreakablePosts(broken);
    const { transport, timers, issues, peer } = await connectRawRig({ wrap });
    const heard = createWatcher();
    transport.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
    const held = captureOutcome(transport.request(notes.read, 'note'));
    await timers.advance(0);

    // When
    breakPosts();
    const call = captureOutcome(transport.request(notes.touch, undefined));
    await timers.advance(0);
    mendPosts();

    // Then the call, the held call and the subscription hear the provider's error, after the hook heard the post
    expect(await call).toBe(broken);
    expect(await held).toBe(broken);
    expect(heard.closes).toEqual([broken]);
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { section: 'notes', method: 'touch' } }]);

    // When a call is made on the closed transport
    const later = captureOutcome(transport.request(notes.touch, undefined));

    // Then it rejects, and the closed transport posts nothing more, not even a stop for the subscription
    expect(await later).toBe(broken);
    expect(peer.getNames()).toEqual(['handshakeOffer', 'start:notes.watch', 'request:notes.read']);
  });

  it('As a caller, I dispose my transport and my pending and later requests reject with the closing error', async () => {
    // Given
    const { opener, accepter, timers } = createRig();
    accepter.handleRequest(notes.read, () => new Promise(() => undefined));
    opener.connect();
    const pending = captureOutcome(opener.request(notes.read, 'note'));
    await timers.advance(0);
    const reason = new Error('the page is closing');

    // When
    opener.dispose(reason);
    const later = captureOutcome(opener.request(notes.read, 'later'));
    const aborted = captureOutcome(opener.request(notes.touch, undefined, { signal: AbortSignal.abort() }));
    const connecting = captureOutcome(opener.whenConnected());

    // Then
    expect(await pending).toBe(reason);
    expect(await later).toBe(reason);
    expect(await aborted).toBe(reason);
    expect(await connecting).toBe(reason);
  });

  it('As a caller, I dispose while calls are queued and they reject with the dispose reason and the handshake stops', async () => {
    // Given
    const { transport, timers, peer, left } = createRawRig({ handshake: 'offer' });
    const reason = new Error('the peer left');

    // When a call is queued while the handshake runs
    transport.connect();
    const call = captureOutcome(transport.request(notes.touch, undefined));
    await timers.advance(100);

    // Then the opener keeps offering
    expect(peer.getNames()).toEqual(['handshakeOffer', 'handshakeOffer', 'handshakeOffer']);

    // When
    const post = vi.spyOn(left, 'postMessage');
    transport.dispose(reason);
    await timers.advance(1_000);
    const connecting = captureOutcome(transport.whenConnected());

    // Then
    expect(await call).toBe(reason);
    expect(await connecting).toBe(reason);
    expect(post).not.toHaveBeenCalled();
  });

  it('As a caller, I call and subscribe across the handshake and both go out in call order', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = createRawRig({ handshake: 'offer' });
    // Registered first, so it hears the handshake end before any queued call does.
    const connected = transport.whenConnected().then(() => {
      transport.subscribe({ method: notes.watch, start: 'once connected', listeners: createWatcher() });
    });
    void transport.request(notes.touch, undefined);
    transport.subscribe({ method: notes.watch, start: 'while connecting', listeners: createWatcher() });
    transport.connect();
    await timers.advance(0);
    void transport.request(echo.say, 'after connect');

    // When
    answerHandshake();
    transport.subscribe({ method: notes.watch, start: 'as the answer arrives', listeners: createWatcher() });
    await connected;
    await timers.advance(0);

    // Then
    expect(peer.getNames()).toEqual([
      'handshakeOffer',
      'request:notes.touch',
      'start:notes.watch',
      'request:echo.say',
      'start:notes.watch',
      'start:notes.watch',
    ]);
    expect(peer.getValues(notes.watch, 'start:notes.watch')).toEqual([
      'while connecting',
      'as the answer arrives',
      'once connected',
    ]);
  });

  it('As a subscriber, I subscribe and hear values, then one interrupt', async () => {
    // Given
    const { opener, accepter, timers, issues } = createRig();
    const { sinks } = serveWatch(accepter);
    opener.connect();
    const clean = createWatcher();
    const failed = createWatcher();
    opener.subscribe({ method: notes.watch, start: 'a', listeners: clean });
    opener.subscribe({ method: notes.watch, start: 'b', listeners: failed });
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

  it('As a subscriber, I stop while queued and nothing is sent and I hear nothing', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = createRawRig({ handshake: 'offer' });
    const heard = createWatcher();
    const unsubscribe = transport.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
    transport.connect();
    await timers.advance(0);

    // When
    unsubscribe();
    answerHandshake();
    await transport.whenConnected();
    await timers.advance(0);
    transport.dispose(new Error('done'));

    // Then
    expect(peer.getNames()).toEqual(['handshakeOffer']);
    expect(heard.ends).toEqual([]);
    expect(heard.fails).toEqual([]);
    expect(heard.closes).toEqual([]);
  });

  it('As a subscriber, I stop my open subscription and one stop is posted and I hear nothing more, a crossing interrupt included', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectRawRig();
    const heard = createWatcher();
    const unsubscribe = transport.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
    await timers.advance(0);
    const [id = 0] = getStartIds(peer);

    // When
    unsubscribe();
    unsubscribe();
    peer.call({ method: notes.watch, id, message: { tag: 'receive', value: 'crossing' } });
    peer.call({ method: notes.watch, id, message: { tag: 'interrupt', value: ok() } });
    await timers.advance(0);

    // Then
    expect(peer.find('stop:notes.watch').map(message => message.id)).toEqual([id]);
    expect(heard.values).toEqual([]);
    expect(heard.ends).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('As a caller, I abort my subscription and a stop is posted and I hear Cancelled once', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectRawRig();
    const heard = createWatcher();
    const abort = new AbortController();
    const unsubscribe = transport.subscribe({
      method: notes.watch,
      start: 'from the top',
      listeners: heard,
      signal: abort.signal,
    });
    await timers.advance(0);
    const [id = 0] = getStartIds(peer);

    // When
    abort.abort();
    unsubscribe();
    peer.call({ method: notes.watch, id, message: { tag: 'receive', value: 'crossing' } });
    await timers.advance(0);

    // Then
    expect(heard.fails).toEqual([cancelled()]);
    expect(heard.ends).toEqual([]);
    expect(heard.values).toEqual([]);
    expect(peer.find('stop:notes.watch').map(message => message.id)).toEqual([id]);
    expect(issues).toEqual([]);
  });

  it('As a caller, I abort a subscription while queued or before it is made and nothing is posted and I hear Cancelled once', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = createRawRig({ handshake: 'offer' });
    const queued = createWatcher();
    const early = createWatcher();
    const abort = new AbortController();
    transport.subscribe({ method: notes.watch, start: 'queued', listeners: queued, signal: abort.signal });

    // When
    transport.subscribe({ method: notes.watch, start: 'early', listeners: early, signal: AbortSignal.abort() });

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
    expect(peer.getNames()).toEqual(['handshakeOffer']);
  });

  it('As a caller, I dispose my transport and my subscription closes once with its error', async () => {
    // Given
    const { opener, accepter, timers, issues } = createRig();
    const { stops } = serveWatch(accepter);
    opener.connect();
    const heard = createWatcher();
    opener.subscribe({ method: notes.watch, start: 'open', listeners: heard });
    const stopped = createWatcher();
    const unsubscribe = opener.subscribe({ method: notes.watch, start: 'stopped', listeners: stopped });
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
    const after = createWatcher();
    opener.subscribe({ method: notes.watch, start: 'after', listeners: after });
    const stoppedAfter = createWatcher();
    opener.subscribe({ method: notes.watch, start: 'stopped after', listeners: stoppedAfter })();
    await timers.advance(0);

    // Then
    expect(after.closes).toEqual([reason]);
    expect(stoppedAfter.closes).toEqual([]);
    expect(stops).toEqual([0, 1]);
    expect(issues).toEqual([]);
  });

  it('As a caller, I abort and close after the peer interrupted my subscription and nothing changes', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectRawRig();
    const heard = createWatcher();
    const abort = new AbortController();
    transport.subscribe({ method: notes.watch, start: 'from the top', listeners: heard, signal: abort.signal });
    await timers.advance(0);
    const [id = 0] = getStartIds(peer);
    peer.call({ method: notes.watch, id, message: { tag: 'interrupt', value: ok() } });
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

  it('As a caller, I dispose while my start is queued and it closes with the reason and no start is posted', async () => {
    // Given
    const { transport, timers, peer } = createRawRig({ handshake: 'offer' });
    const heard = createWatcher();
    transport.subscribe({ method: notes.watch, start: 'queued', listeners: heard });
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

  it('As a caller, I subscribe before a handshake that times out and my subscription closes with why and no start is posted', async () => {
    // Given
    const { transport, timers, peer } = createRawRig({ handshake: 'offer' });
    const heard = createWatcher();
    transport.subscribe({ method: notes.watch, start: 'queued', listeners: heard });

    // When
    transport.connect();
    await timers.advance(TIMEOUT_MS);

    // Then
    expect(heard.closes).toEqual([matchInstance(TransportHandshakeTimeoutError)]);
    expect(heard.ends).toEqual([]);
    expect(peer.find('start:notes.watch')).toEqual([]);
  });

  it('As a subscriber whose listeners throw, I hear values and each throw is reported as listener_threw without stopping the others', async () => {
    // Given
    const { opener, accepter, timers, issues } = createRig();
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
    const heard = createWatcher();
    opener.subscribe({ method: notes.watch, start: 'a', listeners: throwing });
    opener.subscribe({ method: notes.watch, start: 'b', listeners: heard });
    const closing = {
      ...createWatcher(),
      close: vi.fn(() => {
        throw closeBug;
      }),
    };
    opener.subscribe({ method: notes.watch, start: 'c', listeners: closing });
    const closed = createWatcher();
    opener.subscribe({ method: notes.watch, start: 'd', listeners: closed });
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

  it('As a subscriber, I stop and dispose from inside receive and close and each settles once', async () => {
    // Given
    const { opener, accepter, timers } = createRig();
    const { sinks, stops } = serveWatch(accepter);
    opener.connect();
    const reason = new Error('torn down');
    const heardBySelfStopping = vi.fn();
    const unsubscribeSelf = opener.subscribe({
      method: notes.watch,
      start: 'a',
      listeners: {
        receive: () => {
          heardBySelfStopping();
          unsubscribeSelf();
          unsubscribeSelf();
        },
        interrupt: () => undefined,
        fail: () => undefined,
        close: () => undefined,
      },
    });
    const disposingCloses = vi.fn();
    opener.subscribe({
      method: notes.watch,
      start: 'b',
      listeners: {
        receive: () => {
          opener.dispose(reason);
        },
        interrupt: () => undefined,
        fail: () => undefined,
        close: disposingCloses,
      },
    });
    const watcherCloses = vi.fn();
    let callFromClose: Promise<unknown> | undefined;
    const unsubscribeWatched = opener.subscribe({
      method: notes.watch,
      start: 'c',
      listeners: {
        ...createWatcher(),
        close: error => {
          watcherCloses(error);
          unsubscribeWatched();
          opener.dispose(new Error('second dispose'));
          callFromClose = captureOutcome(opener.request(echo.say, 'still there?'));
        },
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

  it('As a caller, I hear a message on a subscription I stopped and it is dropped quietly, while one that cannot be a race is refused as invalid', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectRawRig();
    const stopped = createWatcher();
    const interrupted = createWatcher();
    const open = createWatcher();
    const unsubscribeStopped = transport.subscribe({ method: notes.watch, start: 'stopped', listeners: stopped });
    unsubscribeStopped();
    await timers.advance(0);
    transport.subscribe({ method: notes.watch, start: 'interrupted', listeners: interrupted });
    transport.subscribe({ method: notes.watch, start: 'open', listeners: open });
    await timers.advance(0);
    const [ended = 0, running = 0] = getStartIds(peer);
    peer.call({ method: notes.watch, id: ended, message: { tag: 'interrupt', value: ok() } });
    await timers.advance(0);
    const unsubscribeLater = transport.subscribe({ method: notes.watch, start: 'later', listeners: createWatcher() });
    await timers.advance(0);
    const [, , later = 0] = getStartIds(peer);
    unsubscribeLater();

    // When values and ends come on the stopped one, after the interrupt, under another method, and on an id never used
    peer.call({ method: notes.watch, id: later, message: { tag: 'receive', value: 'crossing' } });
    peer.call({ method: notes.watch, id: later, message: { tag: 'interrupt', value: ok() } });
    peer.call({ method: notes.watch, id: ended, message: { tag: 'receive', value: 'after the end' } });
    peer.call({ method: notes.watch, id: ended, message: { tag: 'interrupt', value: ok() } });
    peer.call({ method: echo.listen, id: running, message: { tag: 'receive', value: 'elsewhere' } });
    peer.call({ method: notes.watch, id: 901, message: { tag: 'receive', value: 'never asked' } });
    await timers.advance(0);

    // Then
    expect(stopped.ends).toEqual([]);
    expect(interrupted.values).toEqual([]);
    expect(interrupted.ends).toEqual([ok()]);
    expect(open.values).toEqual([]);
    expect(open.ends).toEqual([]);
    const refused = matchRefusedIssue('invalid');
    expect(issues).toEqual([refused, refused, refused, refused]);
  });

  it.each([
    {
      leg: 'an interrupt that is cut short',
      failure: malformedFrame('RangeError: Invalid DataView length 2'),
      stopped: false,
      cause: RangeError,
      send: (peer: RawPeer, id: number) => {
        peer.call({ method: rawWatch, id, message: { tag: 'interrupt', value: err(CUT_SHORT_TEXT) }, at: notes.watch });
      },
    },
    {
      leg: 'a value that is cut short',
      failure: malformedFrame('RangeError: Invalid DataView length 2'),
      stopped: true,
      cause: RangeError,
      send: (peer: RawPeer, id: number) => {
        peer.call({ method: rawWatch, id, message: { tag: 'receive', value: CUT_SHORT_TEXT }, at: notes.watch });
      },
    },
    {
      leg: 'an interrupt that leaves bytes unread',
      failure: malformedFrame(TRAILED_REASON),
      stopped: false,
      cause: RangeError,
      send: (peer: RawPeer, id: number) => {
        peer.call({ method: rawWatch, id, message: { tag: 'interrupt', value: err(TRAILED_TEXT) }, at: notes.watch });
      },
    },
    {
      leg: 'a value that leaves bytes unread',
      failure: malformedFrame(TRAILED_REASON),
      stopped: true,
      cause: RangeError,
      send: (peer: RawPeer, id: number) => {
        peer.call({ method: rawWatch, id, message: { tag: 'receive', value: TRAILED_TEXT }, at: notes.watch });
      },
    },
    {
      leg: 'a message whose leg cannot be read',
      failure: { tag: 'MalformedFrame', value: { reason: matchAnyString() } } satisfies Failure,
      stopped: true,
      cause: TypeError,
      send: (peer: RawPeer, id: number) => {
        peer.send(id, createUnreadableLeg(notes.watch));
      },
    },
  ])(
    'As a caller, I hear $leg and my subscription ends as MalformedFrame, reported, and stopped only when it may have been a value',
    async ({ failure, stopped, cause, send }) => {
      // Given
      const { transport, timers, peer, issues } = await connectRawRig();
      const heard = createWatcher();
      transport.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
      await timers.advance(0);
      const [id = 0] = getStartIds(peer);

      // When
      send(peer, id);
      await timers.advance(0);

      // Then what did not decode may have been a value, which is stopped, and nothing follows an interrupt
      expect(heard.fails).toEqual([failure]);
      expect([...heard.values, ...heard.ends]).toEqual([]);
      expect(peer.find('stop:notes.watch').map(message => message.id)).toEqual(stopped ? [id] : []);
      expect(issues).toEqual([matchRefusedIssue('malformed', matchInstance(cause))]);
    },
  );

  it('As a caller, I hear the peer fail my subscription as Unsupported and it ends as Unsupported', async () => {
    // Given
    const { transport, timers, peer, issues } = await connectRawRig();
    const heard = createWatcher();
    transport.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
    await timers.advance(0);
    const [id = 0] = getStartIds(peer);

    // When
    peer.send(id, { tag: 'failed', value: unsupported() });
    await timers.advance(0);

    // Then
    expect(heard.fails).toEqual([unsupported()]);
    expect(heard.ends).toEqual([]);
    expect(peer.find('stop:notes.watch')).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('As a caller, I subscribe with a start that does not encode and it throws and posts nothing', async () => {
    // Given
    const { transport, timers, peer } = await connectRawRig();

    // When
    const thrown = catchError(() => {
      transport.subscribe({ method: notes.watch, start: '', listeners: createWatcher() });
    });

    // Then
    expect(thrown).toEqual(new RangeError('A word is never empty'));

    // When the queue runs
    await timers.advance(0);

    // Then
    expect(peer.getNames()).toEqual(['handshakeOffer']);
  });

  it('As a caller whose issue hook disposes on a failed start post, I subscribe and the peer has nothing to stop', async () => {
    // Given a hook that mends posts and disposes when the start cannot be posted
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = createBreakablePosts(broken);
    const reason = new Error('leaving');
    const issues: TransportIssue[] = [];
    const raw = await connectRawRig({
      wrap,
      onIssue: issue => {
        issues.push(issue);
        if (issue.kind === 'post_failed') {
          mendPosts();
          raw.transport.dispose(reason);
        }
      },
    });
    breakPosts();
    const heard = createWatcher();

    // When
    raw.transport.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
    await raw.timers.advance(0);

    // Then the transport closed it with the hook's reason, and the peer heard no stop
    expect(heard.closes).toEqual([reason]);
    expect(heard.ends).toEqual([]);
    expect(heard.fails).toEqual([]);
    expect(raw.peer.getNames()).toEqual(['handshakeOffer']);
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { section: 'notes', method: 'watch' } }]);
  });

  it('As a caller whose issue hook stops my subscription on its failed start post, I subscribe and the peer has nothing to stop', async () => {
    // Given a hook that mends posts and stops the subscription when its start cannot be posted
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = createBreakablePosts(broken);
    const issues: TransportIssue[] = [];
    // The `unsubscribe` is made after the hook, which runs only once the start is posted.
    const unsubscribes: (() => void)[] = [];
    const raw = await connectRawRig({
      wrap,
      onIssue: issue => {
        issues.push(issue);
        if (issue.kind === 'post_failed') {
          mendPosts();
          unsubscribes[0]?.();
        }
      },
    });
    breakPosts();
    const heard = createWatcher();

    // When
    unsubscribes.push(raw.transport.subscribe({ method: notes.watch, start: 'from the top', listeners: heard }));
    await raw.timers.advance(0);
    raw.transport.dispose(new Error('done'));
    await raw.timers.advance(0);

    // Then `unsubscribe` ended it before the post returned, and the peer heard no stop
    expect(heard.closes).toEqual([]);
    expect(heard.ends).toEqual([]);
    expect(raw.peer.getNames()).toEqual(['handshakeOffer']);
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { section: 'notes', method: 'watch' } }]);
  });

  it('As a caller, I subscribe while my provider cannot post and my subscription and my transport close with why, and the post is reported', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = createBreakablePosts(broken);
    const { transport, timers, peer, issues } = await connectRawRig({ wrap });
    breakPosts();
    const heard = createWatcher();

    // When
    const unsubscribe = transport.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
    await timers.advance(0);
    mendPosts();
    unsubscribe();
    transport.dispose(new Error('done'));
    await timers.advance(0);
    const connecting = captureOutcome(transport.whenConnected());

    // Then
    expect(heard.closes).toEqual([broken]);
    expect(await connecting).toBe(broken);
    expect(heard.ends).toEqual([]);
    expect(heard.fails).toEqual([]);
    expect(peer.getNames()).toEqual(['handshakeOffer']);
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { section: 'notes', method: 'watch' } }]);
  });
});

describe('serving', () => {
  it('As a serving side, I serve with a handler that throws or rejects and the caller hears HostFailure with its name and message, bounded', async () => {
    // Given
    const { opener, accepter, timers } = createRig();
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

  it('As a serving side, I register a second handler for one method and it is refused', () => {
    // Given
    const { accepter } = createRig();
    accepter.handleRequest(notes.read, () => ok('a'));
    accepter.handleSubscription(notes.watch, () => () => undefined);

    // When
    const second = catchError(() => accepter.handleRequest(notes.read, () => ok('b')));
    const secondSubscription = catchError(() => accepter.handleSubscription(notes.watch, () => () => undefined));

    // Then
    expect(second).toEqual(matchFields<Error>({ message: 'notes.read already has a handler' }));
    expect(secondSubscription).toEqual(matchFields<Error>({ message: 'notes.watch already has a handler' }));
  });

  it('As a serving side, I unregister a handler and a call then answers Unsupported', async () => {
    // Given
    const { opener, accepter, timers } = createRig();
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

  it('As a caller, I call while the peer disposes and my call hears nothing, and the late answer is never posted', async () => {
    // Given
    const { opener, accepter, timers, delivered, issues } = createRig();
    const answer = createDeferred<ResultPayload<string, CallError<string>>>();
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

  it('As a serving side, I answer while my provider cannot post and the post is reported and never left unhandled', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts } = createBreakablePosts(broken);
    const { transport, timers, peer, issues } = await acceptRawRig({ wrap });
    const answer = createDeferred<ResultPayload<undefined, CallError<undefined>>>();
    transport.handleRequest(notes.touch, () => answer.promise);
    peer.call({ method: notes.touch, id: 7, message: { tag: 'request', value: undefined } });
    await timers.advance(0);

    // When
    breakPosts();
    answer.resolve(ok());
    await timers.advance(0);

    // Then
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { section: 'notes', method: 'touch' } }]);
  });

  it.each([
    { payload: 'is cut short', value: CUT_SHORT_TEXT, reason: 'RangeError: Invalid DataView length 2' },
    { payload: 'leaves bytes unread', value: TRAILED_TEXT, reason: TRAILED_REASON },
  ])(
    "As a serving side, I hear a request whose payload $payload and answer MalformedFrame with the cause's message, and it is reported",
    async ({ value, reason }) => {
      // Given
      const { transport, timers, peer, issues } = await acceptRawRig();
      const handler = vi.fn(() => ok('never'));
      transport.handleRequest(notes.read, handler);

      // When
      peer.call({ method: rawRead, id: 7, message: { tag: 'request', value }, at: notes.read });
      await timers.advance(0);

      // Then
      expect(peer.getFailures()).toEqual([{ id: 7, value: malformedFrame(reason) }]);
      expect(issues).toEqual([matchRefusedIssue('malformed', matchInstance(RangeError))]);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('As a serving side, I hear a call to a method or a section this schema lacks and answer Unsupported, and a failure about a call I never made is refused', async () => {
    // Given
    const { timers, peer, issues } = await acceptRawRig();

    // When a method and a section this schema lacks are called
    peer.send(9, {
      tag: 'call',
      value: { sectionId: NOTES, methodId: 7, message: toMessageBytes(Uint8Array.of(0, 1, 2)) },
    });
    peer.send(11, { tag: 'call', value: { sectionId: 7, methodId: 0, message: toMessageBytes(Uint8Array.of(0)) } });
    await timers.advance(0);

    // Then
    expect(peer.getFailures()).toEqual([
      { id: 9, value: unsupported() },
      { id: 11, value: unsupported() },
    ]);

    // When the peer fails a call this side never made
    peer.send(4, { tag: 'failed', value: unsupported() });
    await timers.advance(0);

    // Then
    expect(peer.getNames()).toEqual(['handshakeResponse', 'failed', 'failed']);
    expect(issues).toEqual([matchRefusedIssue('invalid')]);
  });

  it('As a serving side, I hear a message of a kind its method lacks and answer MalformedFrame, and a response to the peer is refused as invalid', async () => {
    // Given
    const { transport, timers, peer, issues } = await acceptRawRig();
    serveWatch(transport);
    transport.handleRequest(notes.read, () => ok('never'));

    // When a message on notes.watch has a kind no subscription has, and a response comes for a call of the peer's
    peer.send(5, {
      tag: 'call',
      value: { sectionId: NOTES, methodId: 2, message: toMessageBytes(Uint8Array.of(4, 0x61)) },
    });
    peer.call({ method: notes.read, id: 7, message: { tag: 'response', value: ok('a note') } });
    await timers.advance(0);

    // Then
    expect(peer.getFailures()).toEqual([{ id: 5, value: matchFields<Failure>({ tag: 'MalformedFrame' }) }]);
    expect(issues).toEqual([matchRefusedIssue('malformed', matchInstance(TypeError)), matchRefusedIssue('invalid')]);
  });

  it('As a serving side, I hear a start with no handler and answer Unsupported, and one that does not decode MalformedFrame', async () => {
    // Given
    const { transport, timers, peer } = await acceptRawRig();
    const unregister = transport.handleSubscription(notes.watch, () => () => undefined);
    unregister();
    peer.call({ method: notes.watch, id: 5, message: { tag: 'start', value: 'from the top' } });
    await timers.advance(0);
    serveWatch(transport);

    // When
    peer.call({ method: rawWatch, id: 7, message: { tag: 'start', value: CUT_SHORT_TEXT }, at: notes.watch });
    await timers.advance(0);

    // Then
    expect(peer.getFailures()).toEqual([
      { id: 5, value: unsupported() },
      { id: 7, value: malformedFrame('RangeError: Invalid DataView length 2') },
    ]);
  });

  it('As a serving side, I hear calls before the handshake is over and refuse them as invalid, answering HostFailure at once with no handler run', async () => {
    // Given
    const { transport, timers, peer, issues } = createRawRig({ handshake: 'respond' });
    const handler = vi.fn(() => ok());
    transport.handleRequest(notes.touch, handler);
    const { starts } = serveWatch(transport);

    // When a request, a start, a request whose payload is cut short and a request to a method this schema lacks
    // come first
    peer.call({ method: notes.touch, id: 3, message: { tag: 'request', value: undefined } });
    peer.call({ method: notes.watch, id: 5, message: { tag: 'start', value: 'from the top' } });
    peer.call({ method: rawRead, id: 7, message: { tag: 'request', value: CUT_SHORT_TEXT }, at: notes.read });
    peer.send(9, {
      tag: 'call',
      value: { sectionId: NOTES, methodId: 7, message: toMessageBytes(Uint8Array.of(0, 1, 2)) },
    });
    await timers.advance(0);

    // Then
    const refused = matchRefusedIssue('invalid', matchFields<Error>({ message: 'A call came before the handshake' }));
    expect(issues).toEqual([refused, refused, refused, refused]);
    const notOver = hostFailure('The handshake is not over');
    expect(peer.getFailures()).toEqual([
      { id: 3, value: notOver },
      { id: 5, value: notOver },
      { id: 7, value: notOver },
      { id: 9, value: notOver },
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(starts).toEqual([]);
  });

  it('As a serving side, I hear calls after my handshake failed and refuse them as invalid with the failure and no reply', async () => {
    // Given
    const { timers, peer, issues, openHandshake } = createRawRig({ handshake: 'respond' });
    openHandshake({ version: VERSION + 1 });
    await timers.advance(0);

    // When a call comes on a method of the schema and on one it lacks
    peer.call({ method: notes.touch, id: 3, message: { tag: 'request', value: undefined } });
    peer.send(5, {
      tag: 'call',
      value: { sectionId: NOTES, methodId: 7, message: toMessageBytes(Uint8Array.of(1, 0)) },
    });
    await timers.advance(0);

    // Then
    const refused = matchRefusedIssue(
      'invalid',
      matchFields<Error>({
        message: `A call came after the transport closed, TransportUnsupportedProtocolVersionError: The peer speaks schema version ${String(VERSION + 1)} and this side ${String(VERSION)}.`,
      }),
    );
    expect(issues).toEqual([refused, refused]);
    expect(peer.getNames()).toEqual(['handshakeResponse']);
  });

  it('As an accepter, I hear malformed handshake opens and report them with no reply', async () => {
    // Given
    const { transport, timers, peer, issues } = createRawRig({ handshake: 'respond' });
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
      matchRefusedIssue('malformed', matchInstance(RangeError)),
      matchRefusedIssue('malformed', matchInstance(RangeError)),
    ]);
    expect(peer.heard).toEqual([]);
    expect(connected).toBe(false);
  });

  it('As either side, I hear a hello that leaves bytes unread and refuse it as malformed, settling no handshake', async () => {
    // Given an accepter and an opener that both face a raw peer
    const accepter = createRawRig({ handshake: 'respond' });
    const opener = createRawRig({ handshake: 'offer' });
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

    // Then the accepter answers nothing
    const refused = [matchRefusedIssue('malformed', matchInstance(RangeError))];
    expect(accepter.issues).toEqual(refused);
    expect(accepter.peer.getNames()).toEqual([]);
    expect(opener.issues).toEqual(refused);

    // When the retry interval passes
    const heard = opener.peer.heard.length;
    await opener.timers.advance(RETRY_MS);

    // Then the opener keeps trying
    expect(opener.peer.heard.length).toBeGreaterThan(heard);
  });

  it('As either side, I hear frames of a kind the wire lacks and report them as malformed with no reply', async () => {
    // Given
    const { timers, peer, issues } = await acceptRawRig();

    // When a frame has a kind past the call, then a failure has a variant CallError lacks
    peer.sendBytes(3, 0, 0, 0, 4);
    peer.sendBytes(5, 0, 0, 0, 2, 9);
    await timers.advance(0);

    // Then
    const refused = matchRefusedIssue('malformed', matchInstance(TypeError));
    expect(issues).toEqual([refused, refused]);
    expect(peer.getNames()).toEqual(['handshakeResponse']);
  });

  it.each([
    {
      reuse: 'a request',
      refusal: 'A request reuses call 3, which is still in flight',
      send: (peer: RawPeer) => {
        peer.call({ method: notes.read, id: 3, message: { tag: 'request', value: 'second' } });
      },
    },
    {
      reuse: 'an unreadable subscription message',
      refusal: 'A message reuses call 3, which is still in flight',
      send: (peer: RawPeer) => {
        peer.send(3, createUnreadableLeg(notes.watch));
      },
    },
    {
      reuse: 'a start',
      refusal: 'A start reuses call 3, which is still in flight',
      send: (peer: RawPeer) => {
        peer.call({ method: notes.watch, id: 3, message: { tag: 'start', value: 'from the top' } });
      },
    },
    {
      // Refused rather than answered Unsupported, so the id carries one answer.
      reuse: 'a request for a method I do not serve',
      refusal: 'A request reuses call 3, which is still in flight',
      send: (peer: RawPeer) => {
        peer.call({ method: echo.say, id: 3, message: { tag: 'request', value: 'hello' } });
      },
    },
  ])(
    'As a serving side, I refuse $reuse that reuses an in-flight request id and the request keeps its one answer, as truapi refuses it',
    async ({ refusal, send }) => {
      // Given a request the handler holds on id 3, beside a served subscription
      const { transport, timers, peer, issues } = await acceptRawRig();
      const answer = createDeferred<ResultPayload<string, CallError<string>>>();
      const handler = vi.fn(() => answer.promise);
      transport.handleRequest(notes.read, handler);
      const watch = vi.fn(() => () => undefined);
      transport.handleSubscription(notes.watch, watch);
      peer.call({ method: notes.read, id: 3, message: { tag: 'request', value: 'first' } });
      await timers.advance(0);

      // When the peer reuses the id, and the request is then answered
      send(peer);
      await timers.advance(0);
      answer.resolve(ok('the first'));
      await timers.advance(0);

      // Then nothing runs again, and only the request's answer is posted
      expect(handler).toHaveBeenCalledOnce();
      expect(watch).not.toHaveBeenCalled();
      expect(issues).toEqual([matchRefusedIssue('invalid', matchFields<Error>({ message: refusal }))]);
      expect(peer.getNames()).toEqual(['handshakeResponse', 'response:notes.read']);
      expect(peer.getValues(notes.read, 'response:notes.read')).toEqual([ok('the first')]);

      // When the id is reused once the request was answered
      peer.call({ method: notes.read, id: 3, message: { tag: 'request', value: 'third' } });
      await timers.advance(0);

      // Then it is served
      expect(handler).toHaveBeenCalledTimes(2);
    },
  );

  it('As a serving side, I answer each call of the peer side by side and a slow one holds back no other', async () => {
    // Given
    const { opener, accepter, timers } = createRig();
    const slow = createDeferred<ResultPayload<string, CallError<undefined>>>();
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
    const { transport, timers, peer, issues } = await acceptRawRig();
    const started: unknown[] = [];
    const stop = vi.fn();
    transport.handleSubscription(notes.watch, (start, context) => {
      started.push({ start, context });
      return stop;
    });
    peer.call({ method: notes.watch, id: 5, message: { tag: 'start', value: 'from the top' } });
    await timers.advance(0);

    // When
    peer.call({ method: notes.watch, id: 5, message: { tag: 'stop', value: undefined } });
    peer.call({ method: notes.watch, id: 5, message: { tag: 'stop', value: undefined } });
    await timers.advance(0);

    // Then the second stop stops nothing and is dropped quietly
    expect(started).toEqual([{ start: 'from the top', context: { hello: 'peer' } }]);
    expect(stop).toHaveBeenCalledOnce();
    expect(peer.getNames()).toEqual(['handshakeResponse']);
    expect(issues).toEqual([]);
  });

  it('As a serving side, I serve with a handler that throws on start and the subscriber hears HostFailure', async () => {
    // Given
    const { opener, accepter, timers, issues } = createRig();
    accepter.handleSubscription(notes.watch, () => {
      throw new TypeError('bad start');
    });
    opener.connect();
    const heard = createWatcher();

    // When
    opener.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
    await timers.advance(0);

    // Then
    expect(heard.fails).toEqual([hostFailure('TypeError: bad start')]);
    expect(heard.ends).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('As a handler, I interrupt inside start and my stop function still runs once', async () => {
    // Given
    const { opener, accepter, timers, issues } = createRig();
    const stop = vi.fn();
    accepter.handleSubscription(notes.watch, (_start, _context, sink) => {
      sink.send('only');
      sink.interrupt(err('at once'));
      return stop;
    });
    opener.connect();
    const heard = createWatcher();

    // When
    opener.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
    await timers.advance(0);

    // Then
    expect(heard.values).toEqual(['only']);
    expect(heard.ends).toEqual([err('at once')]);
    expect(stop).toHaveBeenCalledOnce();
    expect(issues).toEqual([]);
  });

  it('As a handler, I send and interrupt after the subscription stopped and nothing is posted', async () => {
    // Given
    const { opener, accepter, timers, delivered } = createRig();
    const { sinks, stops } = serveWatch(accepter);
    opener.connect();
    const unsubscribe = opener.subscribe({ method: notes.watch, start: 'from the top', listeners: createWatcher() });
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

  it('As a handler, I send a value the wire cannot carry and the subscriber hears HostFailure with why, and every end runs my stop', async () => {
    // Given
    const { opener, accepter, timers } = createRig();
    const { sinks, stops } = serveWatch(accepter);
    opener.connect();
    const first = createWatcher();
    const second = createWatcher();
    opener.subscribe({ method: notes.watch, start: 'a', listeners: first });
    opener.subscribe({ method: notes.watch, start: 'b', listeners: second });
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

  it('As a handler, I send while my provider cannot post and the post is reported, my transport closes and my stop runs, with nothing thrown into my call', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts } = createBreakablePosts(broken);
    const { transport, timers, peer, issues } = await acceptRawRig({ wrap });
    const { sinks, stops } = serveWatch(transport);
    peer.call({ method: notes.watch, id: 5, message: { tag: 'start', value: 'from the top' } });
    await timers.advance(0);
    breakPosts();
    const sink = must(sinks[0], 'a sink');

    // When
    const thrownBySend = catchError(() => {
      sink.send('a line');
    });
    const thrownByInterrupt = catchError(() => {
      sink.interrupt(ok());
    });

    // Then
    expect(thrownBySend).toBeUndefined();
    expect(thrownByInterrupt).toBeUndefined();
    expect(issues).toEqual([{ kind: 'post_failed', error: broken, call: { section: 'notes', method: 'watch' } }]);
    expect(stops).toEqual([1]);

    // When the owner waits on the transport
    const connecting = captureOutcome(transport.whenConnected());

    // Then it closed with the provider's error
    expect(await connecting).toBe(broken);
  });

  it('As a serving side whose stop function throws, I dispose and the throw is reported as listener_threw while the others still run', async () => {
    // Given
    const { opener, accepter, timers, issues } = createRig();
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
    opener.subscribe({ method: notes.watch, start: 'a', listeners: createWatcher() });
    opener.subscribe({ method: notes.watch, start: 'b', listeners: createWatcher() });
    await timers.advance(0);

    // When
    accepter.dispose(new Error('the page is closing'));

    // Then
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(stops[1]).toHaveBeenCalledOnce();
    expect(issues).toEqual([{ kind: 'listener_threw', error: bug }]);
  });

  it('As a serving side, I hear a start that reuses the id of a running subscription and replace it with nothing sent, as truapi does, and a stop that names another method is refused as invalid with no reply', async () => {
    // Given
    const { transport, timers, peer, issues } = await acceptRawRig();
    const { starts, stops } = serveWatch(transport);
    peer.call({ method: notes.watch, id: 5, message: { tag: 'start', value: 'first' } });
    await timers.advance(0);

    // When
    peer.call({ method: notes.watch, id: 5, message: { tag: 'start', value: 'second' } });
    peer.call({ method: echo.listen, id: 5, message: { tag: 'stop', value: undefined } });
    await timers.advance(0);

    // Then the first stopped and the second runs
    expect(starts).toEqual(['first', 'second']);
    expect(stops).toEqual([1, 0]);
    expect(issues).toEqual([matchRefusedIssue('invalid')]);
    expect(peer.getNames()).toEqual(['handshakeResponse']);

    // When the peer stops the one that replaced it
    peer.call({ method: notes.watch, id: 5, message: { tag: 'stop', value: undefined } });
    await timers.advance(0);

    // Then
    expect(stops).toEqual([1, 1]);
  });

  it('As a serving side, I hear a start that reuses the id of a running subscription and the old stop runs before the new handler starts', async () => {
    // Given
    const { transport, timers, peer } = await acceptRawRig();
    const log: string[] = [];
    transport.handleSubscription(notes.watch, start => {
      log.push(`start:${start}`);
      return () => {
        log.push(`stop:${start}`);
      };
    });
    peer.call({ method: notes.watch, id: 5, message: { tag: 'start', value: 'first' } });
    await timers.advance(0);

    // When
    peer.call({ method: notes.watch, id: 5, message: { tag: 'start', value: 'second' } });
    await timers.advance(0);

    // Then
    expect(log).toEqual(['start:first', 'stop:first', 'start:second']);
  });

  it("As a serving side, I hear a start that reuses the id of a running subscription and the replaced one's sink sends nothing", async () => {
    // Given
    const { transport, timers, peer } = await acceptRawRig();
    const { sinks, stops } = serveWatch(transport);
    peer.call({ method: notes.watch, id: 5, message: { tag: 'start', value: 'first' } });
    await timers.advance(0);
    peer.call({ method: notes.watch, id: 5, message: { tag: 'start', value: 'second' } });
    await timers.advance(0);
    const replaced = must(sinks[0], 'the replaced sink');

    // When the replaced sink sends, sends what the wire cannot carry, and interrupts, then the new one sends
    replaced.send('stale');
    replaced.send('');
    replaced.interrupt(ok());
    must(sinks[1], 'the new sink').send('fresh');
    await timers.advance(0);

    // Then only the new one's value reaches the peer, and the new one still runs
    expect(peer.getNames()).toEqual(['handshakeResponse', 'receive:notes.watch']);
    expect(stops).toEqual([1, 0]);
  });

  it('As a serving side, I see a peer dispose and what it opened keeps running, since it posts nothing', async () => {
    // Given a peer with a subscription
    const { opener, accepter, timers } = createRig();
    const { stops } = serveWatch(accepter);
    opener.subscribe({ method: notes.watch, start: 'tick', listeners: createWatcher() });
    await timers.advance(0);

    // When the peer disposes its transport
    opener.dispose(new Error('leaving'));
    await timers.advance(0);

    // Then
    expect(stops).toEqual([0]);
  });

  it('As a handler whose stop function disposes the transport, I interrupt and the peer still hears it', async () => {
    // Given
    const { opener, accepter, timers, issues } = createRig();
    const sinks: Sink<string, ResultPayload<undefined, string>>[] = [];
    accepter.handleSubscription(notes.watch, (_start, _context, sink) => {
      sinks.push(sink);
      return () => {
        accepter.dispose(new Error('done here'));
      };
    });
    opener.connect();
    const ended = createWatcher();
    const other = createWatcher();
    opener.subscribe({ method: notes.watch, start: 'a', listeners: ended });
    opener.subscribe({ method: notes.watch, start: 'b', listeners: other });
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

  it('As a handler that interrupts and then breaks my channel inside start, I interrupt the subscription and the subscriber hears the interrupt first', async () => {
    // Given
    const { wrap, breakPosts } = createBreakablePosts(new Error('the port is closed'));
    const { transport, timers, peer, issues } = await acceptRawRig({ wrap });
    const stop = vi.fn();
    transport.handleSubscription(notes.watch, (_start, _context, sink) => {
      sink.interrupt(err('released'));
      breakPosts();
      return stop;
    });

    // When
    peer.call({ method: notes.watch, id: 5, message: { tag: 'start', value: 'from the top' } });
    await timers.advance(0);

    // Then
    expect(peer.getValues(notes.watch, 'interrupt:notes.watch')).toEqual([err('released')]);
    expect(issues).toEqual([]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('As a serving side, I hear a stop before the handshake and refuse it as invalid, and drop one for a subscription that is not running quietly', async () => {
    // Given
    const { transport, timers, peer, issues, openHandshake } = createRawRig({ handshake: 'respond' });
    serveWatch(transport);

    // When a stop comes before the handshake, then one names an id never started, and one a method with no handler
    peer.call({ method: notes.watch, id: 1, message: { tag: 'stop', value: undefined } });
    await timers.advance(0);
    openHandshake();
    await timers.advance(0);
    peer.call({ method: notes.watch, id: 3, message: { tag: 'stop', value: undefined } });
    peer.call({ method: echo.listen, id: 5, message: { tag: 'stop', value: undefined } });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      matchRefusedIssue('invalid', matchFields<Error>({ message: 'A call came before the handshake' })),
    ]);
    expect(peer.getNames()).toEqual(['handshakeResponse']);
  });
});

describe('the handshake', () => {
  it('As an owner whose hello does not encode, I create either side and it fails with why', () => {
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
    const thrownBySides = [
      { provider: left, handshake: 'offer' as const },
      { provider: right, handshake: 'respond' as const },
    ].map(({ provider, handshake }) =>
      catchError(() => createTransport({ schema, provider, handshake, hello: 'a side', timers: createManualTimers() })),
    );

    // Then
    expect(thrownBySides).toEqual([refused, refused]);
  });

  it('As a peer, I connect the opener and each side hears the other, and the accepter needs no connect', async () => {
    // Given
    const { opener, accepter, timers } = createRig();
    const opened = captureOutcome(opener.whenConnected());
    const accepted = captureOutcome(accepter.whenConnected());

    // When
    accepter.connect();
    opener.connect();
    opener.connect();
    await timers.advance(0);

    // Then
    expect(await opened).toEqual({ value: undefined });
    expect(await accepted).toEqual({ value: undefined });
  });

  it('As a caller with an aborted signal, I wait for the handshake and my wait rejects while other waiters still connect', async () => {
    // Given
    const { opener, timers } = createRig();
    const waiting = captureOutcome(opener.whenConnected());

    // When
    const aborted = captureOutcome(opener.whenConnected({ signal: AbortSignal.abort(new Error('the caller left')) }));
    await timers.advance(0);

    // Then
    expect(await aborted).toEqual(
      matchFields<DOMException>({ name: 'AbortError', message: 'The wait for the handshake was aborted' }),
    );
    expect(await waiting).toEqual({ value: undefined });
  });

  it('As a caller with an aborted signal, I wait on a closed transport and my wait rejects with the closing error', async () => {
    // Given
    const { opener } = createRig();
    const closing = new Error('the owner left');
    opener.dispose(closing);

    // When
    const waited = captureOutcome(opener.whenConnected({ signal: AbortSignal.abort(new Error('the caller left')) }));

    // Then
    expect(await waited).toBe(closing);
  });

  it('As a caller that aborts mid-wait, I stop waiting and another waiter still connects', async () => {
    // Given
    const { opener, timers } = createRig();
    const leaving = new AbortController();
    const left = captureOutcome(opener.whenConnected({ signal: leaving.signal }));
    const staying = captureOutcome(opener.whenConnected());

    // When
    leaving.abort('the caller left');
    await timers.advance(0);

    // Then
    expect(await left).toEqual(matchFields<DOMException>({ name: 'AbortError', message: 'the caller left' }));
    expect(await staying).toEqual({ value: undefined });
  });

  it('As a caller whose wait connects, I leave no abort listener on my signal', async () => {
    // Given
    const { opener, timers } = createRig();
    const { signal } = new AbortController();
    const attach = vi.spyOn(signal, 'addEventListener');
    const detach = vi.spyOn(signal, 'removeEventListener');

    // When
    const connected = captureOutcome(opener.whenConnected({ signal }));
    await timers.advance(0);

    // Then
    expect(await connected).toEqual({ value: undefined });
    expect(attach).toHaveBeenCalledOnce();
    expect(detach.mock.calls).toEqual(attach.mock.calls.map(([type, listener]) => [type, listener]));
  });

  it('As an opener on a schema whose hello is void, I complete the handshake and connect', async () => {
    // Given both sides of a schema whose hello decodes to undefined, and an accepter that records the hello it hears
    const schema = defineSchema({ version: VERSION, hello: _void, sections: { notes: { touch: notes.touch } } });
    const { left, right } = createProviderPair();
    const timers = createManualTimers();
    const opener = createTransport({ schema, provider: left, handshake: 'offer', hello: undefined, timers });
    const accepter = createTransport({ schema, provider: right, handshake: 'respond', hello: undefined });
    const hellos: unknown[] = [];
    accepter.handleRequest(notes.touch, (_payload, context) => {
      hellos.push(context.hello);
      return ok();
    });
    const opened = captureOutcome(opener.whenConnected());
    const accepted = captureOutcome(accepter.whenConnected());

    // When
    const answer = opener.request(notes.touch, undefined);
    await timers.advance(0);

    // Then
    expect(await opened).toEqual({ value: undefined });
    expect(await accepted).toEqual({ value: undefined });
    expect(await answer).toEqual(ok());
    expect(hellos).toEqual([undefined]);
  });

  it('As an opener, I hear a garbage answer and my handshake survives it and times out only on the running clock', async () => {
    // Given
    const { transport, timers, peer, issues } = createRawRig({ handshake: 'offer' });
    transport.connect();
    let settled: unknown;
    void captureOutcome(transport.whenConnected()).then(outcome => {
      settled = outcome;
    });

    // When
    peer.sendBytes(0xff, 0xff, 0xff);
    await timers.advance(0);

    // Then
    expect(issues).toEqual([matchRefusedIssue('malformed', matchInstance(RangeError))]);

    // When the retry interval passes
    const heard = peer.heard.length;
    await timers.advance(RETRY_MS);

    // Then it offers again
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

  it('As an owner who bounds the wait itself, I open with no deadline and my opener keeps offering past the default one until it is answered', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = createRawRig({ handshake: 'offer', timeoutMs: null });
    const opened = captureOutcome(transport.whenConnected());

    // When it waits twice the default deadline, then is answered
    await timers.advance(20_000);
    const offers = peer.find('handshakeOffer').length;
    answerHandshake();
    await timers.advance(0);

    // Then it kept offering and connects
    expect(offers).toBeGreaterThan(20_000 / RETRY_MS / 2);
    expect(await opened).toEqual({ value: undefined });
  });

  it('As an opener with no timeout set, I connect and my handshake waits 10 seconds for an answer, as host-api and truapi wait', async () => {
    // Given
    const { left } = createProviderPair();
    const timers = createManualTimers();
    const transport = createTransport({
      schema: testSchema,
      provider: left,
      handshake: 'offer',
      hello: 'opener',
      timers,
    });
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

  it('As an opener, I hear a handshake answer after my handshake timed out and nothing changes', async () => {
    // Given
    const { transport, timers, peer, answerHandshake } = createRawRig({ handshake: 'offer' });
    const call = captureOutcome(transport.request(notes.touch, undefined));

    // When the handshake runs out of time
    transport.connect();
    await timers.advance(TIMEOUT_MS);
    const timedOut = await captureOutcome(transport.whenConnected());

    // Then
    expect(timedOut).toBeInstanceOf(TransportHandshakeTimeoutError);

    // When the answer then comes, and the owner waits and calls again
    const heard = peer.heard.length;
    answerHandshake();
    await timers.advance(RETRY_MS * 10);
    const connecting = captureOutcome(transport.whenConnected());
    const later = captureOutcome(transport.request(notes.touch, undefined));

    // Then
    expect(await connecting).toBe(timedOut);
    expect(await call).toBe(timedOut);
    expect(await later).toBe(timedOut);
    expect(peer.heard).toHaveLength(heard);
  });

  it('As an opener, I hear a peer of another version and my handshake fails at once with both versions', async () => {
    // Given
    const { transport, timers, peer } = createRawRig({ handshake: 'offer' });
    transport.connect();
    const call = captureOutcome(transport.request(notes.touch, undefined));
    await timers.advance(0);
    const attempt = must(peer.heard[0], 'a handshake');

    // When
    peer.send(attempt.id, {
      tag: 'handshakeResponse',
      value: err({ wire: WIRE_VERSION, schema: VERSION + 1 }),
    });
    await timers.advance(0);
    const failure = await captureOutcome(transport.whenConnected());

    // Then
    expect(failure).toBeInstanceOf(TransportUnsupportedProtocolVersionError);
    expect(failure).toMatchObject({
      message: `The peer speaks schema version ${String(VERSION + 1)} and this side ${String(VERSION)}.`,
      ours: { wire: WIRE_VERSION, schema: VERSION },
      theirs: { wire: WIRE_VERSION, schema: VERSION + 1 },
    });
    expect(await call).toBe(failure);

    // When the retry interval passes many times
    const heard = peer.heard.length;
    await timers.advance(RETRY_MS * 10);

    // Then it offers no more
    expect(peer.heard).toHaveLength(heard);
  });

  it('As an opener, I retry and flush and every post is a fresh buffer', async () => {
    // Given
    const { transport, timers, peer, left, answerHandshake } = createRawRig({ handshake: 'offer' });
    const post = vi.spyOn(left, 'postMessage');
    const calls = [1, 2, 3].map(() => captureOutcome(transport.request(notes.touch, undefined)));

    // When
    transport.connect();
    await timers.advance(RETRY_MS * 3);
    answerHandshake();
    await transport.whenConnected();
    await timers.advance(0);

    // Then
    expect(peer.getNames()).toEqual([
      'handshakeOffer',
      'handshakeOffer',
      'handshakeOffer',
      'handshakeOffer',
      'request:notes.touch',
      'request:notes.touch',
      'request:notes.touch',
    ]);
    expect(post.mock.results.every(result => result.type === 'return')).toBe(true);

    // When
    const done = new Error('done');
    transport.dispose(done);

    // Then the calls the peer never answered close with the reason
    expect(await Promise.all(calls)).toEqual([done, done, done]);
  });

  it('As an opener, I connect while my provider cannot post and my handshake fails at once with why, and the post is reported', async () => {
    // Given
    const { left } = createProviderPair();
    const broken = new Error('port closed');
    const provider: Provider = {
      ...left,
      postMessage: () => {
        throw broken;
      },
    };
    const timers = createManualTimers();
    const { issues, onIssue } = createIssueLog();
    const transport = createTransport({
      schema: testSchema,
      provider,
      handshake: 'offer',
      hello: 'opener',
      timers,
      onIssue,
    });

    // When
    transport.connect();
    const outcome = captureOutcome(transport.whenConnected());
    await timers.advance(0);

    // Then
    expect(await outcome).toBe(broken);
    expect(issues).toEqual([{ kind: 'post_failed', error: broken }]);
  });

  it('As an opener, I make my first request, subscription or wait and it starts the handshake, as host-api starts it, and an accepter starts nothing', async () => {
    // Given three openers and an accepter, none of which connects
    const requesting = createRawRig({ handshake: 'offer' });
    const subscribing = createRawRig({ handshake: 'offer' });
    const waiting = createRawRig({ handshake: 'offer' });
    const accepting = createRawRig({ handshake: 'respond' });

    // When each calls
    void captureOutcome(requesting.transport.request(notes.touch, undefined));
    subscribing.transport.subscribe({ method: notes.watch, start: 'from the top', listeners: createWatcher() });
    void captureOutcome(waiting.transport.whenConnected());
    void captureOutcome(accepting.transport.request(notes.touch, undefined));
    accepting.transport.subscribe({ method: notes.watch, start: 'from the top', listeners: createWatcher() });
    void captureOutcome(accepting.transport.whenConnected());
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

  it('As an accepter, I hear an opener of another wire version and refuse it with both my versions, and each side names the wire version that differs', async () => {
    // Given an opener on the next wire version that offers the handshake through a raw peer
    const { transport, timers, peer, openHandshake } = createRawRig({ handshake: 'respond' });

    // When
    openHandshake({ id: 1, wire: WIRE_VERSION + 1 });
    await timers.advance(0);
    const failure = await captureOutcome(transport.whenConnected());

    // Then
    expect(peer.getHandshakeResponses()).toEqual([{ id: 1, value: err({ wire: WIRE_VERSION, schema: VERSION }) }]);
    expect(failure).toBeInstanceOf(TransportUnsupportedProtocolVersionError);
    expect(failure).toMatchObject({
      message: `The peer speaks wire version ${String(WIRE_VERSION + 1)} and this side ${String(WIRE_VERSION)}.`,
    });
  });

  it('As an opener, I hear a peer whose wire and schema versions both differ and my handshake fails naming both', async () => {
    // Given
    const { transport, timers, peer } = createRawRig({ handshake: 'offer' });
    transport.connect();
    await timers.advance(0);
    const attempt = must(peer.heard[0], 'a handshake');

    // When
    peer.send(attempt.id, {
      tag: 'handshakeResponse',
      value: err({ wire: WIRE_VERSION + 1, schema: VERSION + 1 }),
    });
    await timers.advance(0);
    const connecting = captureOutcome(transport.whenConnected());

    // Then
    expect(await connecting).toMatchObject({
      name: 'TransportUnsupportedProtocolVersionError',
      message:
        `The peer speaks wire version ${String(WIRE_VERSION + 1)} and this side ${String(WIRE_VERSION)}. ` +
        `The peer speaks schema version ${String(VERSION + 1)} and this side ${String(VERSION)}.`,
    });
  });

  it('As an accepter, I hear two handshake attempts and answer each with the outcome of the first', async () => {
    // Given
    const { transport, timers, peer, openHandshake } = createRawRig({ handshake: 'respond' });

    // When
    openHandshake({ id: 1 });
    openHandshake({ id: 3 });
    await timers.advance(0);
    const connecting = transport.whenConnected();

    // Then
    expect(peer.getHandshakeResponses()).toEqual([
      { id: 1, value: ok(str.enc('accepter')) },
      { id: 3, value: ok(str.enc('accepter')) },
    ]);
    await expect(connecting).resolves.toBeUndefined();
  });

  it('As an accepter, I refuse an attempt of another version and close with both versions, and a later attempt is refused with no answer', async () => {
    // Given
    const { transport, timers, peer, issues, openHandshake } = createRawRig({ handshake: 'respond' });
    const call = captureOutcome(transport.request(notes.touch, undefined));

    // When
    openHandshake({ version: VERSION + 1, id: 1 });
    openHandshake({ version: VERSION + 1, id: 3 });
    await timers.advance(0);
    const failure = await captureOutcome(transport.whenConnected());

    // Then
    expect(peer.getHandshakeResponses()).toEqual([{ id: 1, value: err({ wire: WIRE_VERSION, schema: VERSION }) }]);
    expect(issues).toEqual([
      matchRefusedIssue(
        'invalid',
        matchFields<Error>({
          message: matchStringContaining('A handshake offer came after the transport closed'),
        }),
      ),
    ]);
    expect(failure).toBeInstanceOf(TransportUnsupportedProtocolVersionError);
    expect(failure).toMatchObject({
      message: `The peer speaks schema version ${String(VERSION + 1)} and this side ${String(VERSION)}.`,
    });
    expect(await call).toBe(failure);
    expect(peer.getNames()).not.toContain('request:notes.touch');
  });

  it('As an opener, I hear a handshake answer before my handshake started and refuse it as invalid', async () => {
    // Given an opener that made no call
    const { transport, timers, peer, issues } = createRawRig({ handshake: 'offer' });

    // When
    peer.send(1, { tag: 'handshakeResponse', value: ok(str.enc('peer')) });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([matchRefusedIssue('invalid')]);
    expect(peer.heard).toEqual([]);

    // When the owner then waits for the handshake
    const connecting = transport.whenConnected();
    await timers.advance(0);

    // Then the answer settled nothing, so the handshake it starts waits for an answer of its own
    expect(await Promise.race([connecting, Promise.resolve('still waiting')])).toBe('still waiting');
    expect(peer.getNames()).toEqual(['handshakeOffer']);
  });

  it('As an accepter, I answer while my provider cannot post and close with why, and the next attempt is refused with no answer', async () => {
    // Given
    const broken = new Error('the peer window is gone');
    const { wrap, breakPosts, mendPosts } = createBreakablePosts(broken);
    const { transport, timers, peer, issues, openHandshake } = createRawRig({ handshake: 'respond', wrap });
    const call = captureOutcome(transport.request(notes.touch, undefined));
    breakPosts();

    // When
    openHandshake({ id: 1 });
    await timers.advance(0);
    const connecting = captureOutcome(transport.whenConnected());

    // Then
    expect(issues).toEqual([{ kind: 'post_failed', error: broken }]);
    expect(await connecting).toBe(broken);
    expect(await call).toBe(broken);

    // When
    mendPosts();
    openHandshake({ id: 3 });
    await timers.advance(0);

    // Then
    expect(issues).toHaveLength(2);
    expect(issues[1]).toMatchObject({ kind: 'refused', reason: 'invalid' });
    expect(peer.heard).toEqual([]);
  });

  it('As either side, I hear a handshake leg meant for the other side and refuse it as invalid', async () => {
    // Given
    const opening = createRawRig({ handshake: 'offer' });
    const accepting = createRawRig({ handshake: 'respond' });

    // When
    opening.openHandshake();
    accepting.peer.send(1, { tag: 'handshakeResponse', value: ok(str.enc('peer')) });
    await opening.timers.advance(0);

    // Then
    expect(opening.issues).toEqual([matchRefusedIssue('invalid')]);
    expect(accepting.issues).toEqual([matchRefusedIssue('invalid')]);
    expect(opening.peer.heard).toEqual([]);
    expect(accepting.peer.heard).toEqual([]);
  });
});

describe('forwarding', () => {
  it('As a forwarder, I pass a request and its answer through and every byte of the message is the same on both links', async () => {
    // Given
    const { peer, server, timers, issues, toForwarder, toUpstream } = createForwardRig();
    server.handleRequest(notes.read, (key, { hello }) => ok(`${key}, read for the ${hello}`));

    // When
    const read = peer.request(notes.read, 'a note');
    await timers.advance(0);

    // Then
    expect(await read).toEqual(ok('a note, read for the upstream'));
    const request = [toHex(notes.read.message.enc({ tag: 'request', value: 'a note' }))];
    const response = [toHex(notes.read.message.enc({ tag: 'response', value: ok('a note, read for the upstream') }))];
    expect(getMessageHex(toForwarder, 'request:notes.read')).toEqual(request);
    expect(getMessageHex(toUpstream, 'request:notes.read')).toEqual(request);
    expect(getMessageHex(toUpstream, 'response:notes.read')).toEqual(response);
    expect(getMessageHex(toForwarder, 'response:notes.read')).toEqual(response);
    expect(issues).toEqual([]);
  });

  it("As a forwarder, I pass the upstream's failure back and the peer's call hears it as a failed frame", async () => {
    // Given a server with no handler for the method
    const { peer, timers, issues, toForwarder, toUpstream } = createForwardRig();

    // When
    const said = peer.request(echo.say, 'hello');
    await timers.advance(0);

    // Then
    expect(await said).toEqual(err(unsupported()));
    expect(getFrameNames(toUpstream)).toEqual(['handshakeOffer', 'handshakeResponse', 'request:echo.say', 'failed']);
    expect(getFrameNames(toForwarder)).toEqual(['handshakeOffer', 'handshakeResponse', 'request:echo.say', 'failed']);
    expect(issues).toEqual([]);
  });

  it("As a forwarder, I pass a subscription's values and its interrupt through, and the peer's stop reaches the upstream", async () => {
    // Given
    const { peer, server, timers, issues, toForwarder, toUpstream } = createForwardRig();
    const { starts, sinks, stops } = serveWatch(server);
    const heard = createWatcher();
    peer.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
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
      expect(getMessageHex(toForwarder, name)).toEqual([message]);
      expect(getMessageHex(toUpstream, name)).toEqual([message]);
    }

    // When the peer stops a second one
    const unsubscribe = peer.subscribe({ method: notes.watch, start: 'again', listeners: createWatcher() });
    await timers.advance(0);
    unsubscribe();
    await timers.advance(0);

    // Then
    expect(stops).toEqual([1, 1]);
    const stop = [toHex(notes.watch.message.enc({ tag: 'stop', value: undefined }))];
    expect(getMessageHex(toForwarder, 'stop:notes.watch')).toEqual(stop);
    expect(getMessageHex(toUpstream, 'stop:notes.watch')).toEqual(stop);
    expect(issues).toEqual([]);
  });

  it('As a forwarder, I pass calls through and decode no payload in the middle', async () => {
    // Given
    const { schema, getDecodeCount } = createCountedSchema();
    const { read, watch } = schema.sections.notes;
    const { peer, server, timers, issues } = createForwardRig(schema);
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
    expect(getDecodeCount()).toBe(2);

    // When
    const heard = createWatcher();
    peer.subscribe({ method: watch, start: 'first', listeners: heard });
    await timers.advance(0);

    // Then the server decoded the start and the peer each value
    expect(heard.values).toEqual(['first', 'second']);
    expect(getDecodeCount()).toBe(5);
    expect(issues).toEqual([]);
  });

  it('As a forwarder, I lose my upstream under forwarded calls and answer each HostFailure', async () => {
    // Given
    const { peer, upstream, server, timers, issues } = createForwardRig();
    server.handleRequest(notes.read, () => createDeferred<ResultPayload<string, CallError<string>>>().promise);
    serveWatch(server);
    const read = peer.request(notes.read, 'a note');
    const heard = createWatcher();
    peer.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
    await timers.advance(0);

    // When
    upstream.dispose(new Error('gone'));
    await timers.advance(0);

    // Then
    expect(await read).toEqual(err(hostFailure(new Error('gone'))));
    expect(heard.fails).toEqual([hostFailure(new Error('gone'))]);
    expect(issues).toEqual([]);
  });

  it('As a transport that closes, I end my calls and each one ends in the order I opened it, a forwarded call among them', async () => {
    // Given a forwarder whose posts to its peer are logged, and an upstream with a subscription, then a forwarded call
    const log: string[] = [];
    const near = createProviderPair();
    const far = createProviderPair();
    const timers = createManualTimers();
    const { onIssue } = createIssueLog();
    const opening = { timers, retryMs: RETRY_MS, timeoutMs: TIMEOUT_MS, onIssue };
    const peer = createTransport({
      schema: testSchema,
      provider: near.left,
      handshake: 'offer',
      hello: 'peer',
      ...opening,
    });
    const forwarder = createTransport({
      schema: testSchema,
      provider: {
        ...near.right,
        postMessage: message => {
          log.push('posted');
          near.right.postMessage(message);
        },
      },
      handshake: 'respond',
      hello: 'forwarder',
      onIssue,
    });
    const upstream = createTransport({
      schema: testSchema,
      provider: far.left,
      handshake: 'offer',
      hello: 'upstream',
      ...opening,
    });
    const server = createTransport({
      schema: testSchema,
      provider: far.right,
      handshake: 'respond',
      hello: 'server',
      onIssue,
    });
    forwarder.forward([notes.read], upstream);
    server.handleRequest(notes.read, () => createDeferred<ResultPayload<string, CallError<string>>>().promise);
    serveWatch(server);
    upstream.subscribe({
      method: notes.watch,
      start: 'from the top',
      listeners: {
        ...createWatcher(),
        close: () => {
          log.push('closed');
        },
      },
    });
    await timers.advance(0);
    void peer.request(notes.read, 'a note');
    await timers.advance(0);
    log.length = 0;

    // When
    upstream.dispose(new Error('gone'));

    // Then the subscription opened first hears its end first, and the forwarded call answers its peer after it
    expect(log).toEqual(['closed', 'posted']);
  });

  it('As a forwarder that closes, I post nothing to my peer and stop each forwarded subscription on the upstream', async () => {
    // Given
    const { peer, forwarder, server, timers, issues, toForwarder, toUpstream } = createForwardRig();
    const answer = createDeferred<ResultPayload<string, CallError<string>>>();
    server.handleRequest(notes.read, () => answer.promise);
    const { stops } = serveWatch(server);
    void peer.request(notes.read, 'a note');
    const heard = createWatcher();
    peer.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
    await timers.advance(0);
    const posted = toForwarder.length;

    // When
    forwarder.dispose(new Error('closing'));
    await timers.advance(0);
    answer.resolve(ok('too late'));
    await timers.advance(0);

    // Then the late answer is dropped on the upstream, and the peer hears nothing
    expect(stops).toEqual([1]);
    expect(getMessageHex(toUpstream, 'stop:notes.watch')).toEqual([
      toHex(notes.watch.message.enc({ tag: 'stop', value: undefined })),
    ]);
    expect(getMessageHex(toUpstream, 'response:notes.read')).toEqual([
      toHex(notes.read.message.enc({ tag: 'response', value: ok('too late') })),
    ]);
    expect(toForwarder).toHaveLength(posted);
    expect([heard.values, heard.ends, heard.fails, heard.closes]).toEqual([[], [], [], []]);
    expect(issues).toEqual([]);
  });

  it('As a forwarder, I refuse a stop with trailing bytes and the subscription keeps running on both links until a whole stop ends it', async () => {
    // Given a forwarded subscription on id 1
    const { peer, timers, issues, server } = await forwardFromRawPeer();
    const { sinks, stops } = serveWatch(server);
    peer.call({ method: notes.watch, id: 1, message: { tag: 'start', value: 'from the top' } });
    await timers.advance(0);
    const { sectionId, methodId } = testSchema.addressOf(notes.watch);

    // When
    peer.send(1, { tag: 'call', value: { sectionId, methodId, message: TRAILED_STOP } });
    await timers.advance(0);
    must(sinks[0], 'the sink').send('still here');
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      matchRefusedIssue(
        'malformed',
        matchFields<Error>({ message: 'The value is followed by unread bytes, 1 in all' }),
      ),
    ]);
    expect(stops).toEqual([0]);
    expect(peer.getValues(notes.watch, 'receive:notes.watch')).toEqual(['still here']);
    expect(peer.getFailures()).toEqual([]);

    // When
    peer.call({ method: notes.watch, id: 1, message: { tag: 'stop', value: undefined } });
    await timers.advance(0);

    // Then
    expect(stops).toEqual([1]);
    expect(issues).toHaveLength(1);
  });

  it("As a forwarder, I start the upstream's handshake with the first forwarded call and send it once the handshake is over", async () => {
    // Given
    const { peer, server, timers, issues, toUpstream } = createForwardRig();
    server.handleRequest(echo.say, text => ok(text));

    // When the peer connects to the forwarder
    peer.connect();
    await timers.advance(0);

    // Then the upstream hears nothing yet
    expect(toUpstream).toEqual([]);

    // When the peer makes a forwarded call
    const said = peer.request(echo.say, 'hello');
    await timers.advance(0);

    // Then
    expect(await said).toEqual(ok('hello'));
    expect(getFrameNames(toUpstream)).toEqual([
      'handshakeOffer',
      'handshakeResponse',
      'request:echo.say',
      'response:echo.say',
    ]);
    expect(issues).toEqual([]);
  });

  it('As a forwarder, I end a subscription stopped while its start waits for the upstream and post nothing upstream', async () => {
    // Given a raw peer, and a raw server behind the upstream that has not answered the handshake
    const near = createRawRig({ handshake: 'respond' });
    const far = createRawRig({ handshake: 'offer' });
    near.transport.forward([notes.watch], far.transport);
    near.openHandshake();
    await near.timers.advance(0);
    near.peer.call({ method: notes.watch, id: 1, message: { tag: 'start', value: 'from the top' } });
    await near.timers.advance(0);

    // When
    near.peer.call({ method: notes.watch, id: 1, message: { tag: 'stop', value: undefined } });
    await near.timers.advance(0);
    far.answerHandshake();
    await far.transport.whenConnected();
    await far.timers.advance(0);

    // Then the late handshake opens nothing
    expect(far.peer.getNames()).toEqual(['handshakeOffer']);
    expect(near.peer.getNames()).toEqual(['handshakeResponse']);
    expect([...near.issues, ...far.issues]).toEqual([]);
  });

  it('As a forwarder, I stop forwarding a method and new calls of it are Unsupported while open ones run to their end', async () => {
    // Given
    const { peer, server, timers, issues, stopForwarding } = createForwardRig();
    const answer = createDeferred<ResultPayload<string, CallError<string>>>();
    server.handleRequest(notes.read, () => answer.promise);
    const { sinks, stops } = serveWatch(server);
    const read = peer.request(notes.read, 'a note');
    const heard = createWatcher();
    const unsubscribe = peer.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
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
    const { peer, server, timers, issues, toForwarder, toUpstream } = createForwardRig();
    server.handleRequest(echo.say, text => ok(text));
    const text = 'a 1 MB note'.repeat(100_000).slice(0, 1_000_000);

    // When
    const said = peer.request(echo.say, text);
    await timers.advance(0);

    // Then
    expect(await said).toEqual(ok(text));
    const request = [toHex(echo.say.message.enc({ tag: 'request', value: text }))];
    const response = [toHex(echo.say.message.enc({ tag: 'response', value: ok(text) }))];
    expect(getMessageHex(toForwarder, 'request:echo.say')).toEqual(request);
    expect(getMessageHex(toUpstream, 'request:echo.say')).toEqual(request);
    expect(getMessageHex(toUpstream, 'response:echo.say')).toEqual(response);
    expect(getMessageHex(toForwarder, 'response:echo.say')).toEqual(response);
    expect(issues).toEqual([]);
  });

  it('As a forwarder, I pass an unreadable value through and the peer refuses it and stops it on the upstream', async () => {
    // Given
    const { peer, timers, issues, server } = await forwardToRawServer();
    const heard = createWatcher();
    peer.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
    await timers.advance(0);
    const id = getHeardId(server, 'start:notes.watch');

    // When
    server.send(id, createUnreadableLeg(notes.watch));
    await timers.advance(0);

    // Then the peer refuses it as a lost value and tells the server to stop
    expect(heard.fails).toEqual([matchFields<Failure>({ tag: 'MalformedFrame' })]);
    expect(server.find('stop:notes.watch').map(stop => stop.id)).toEqual([id]);
    expect(issues).toEqual([matchRefusedIssue('malformed')]);
  });

  it('As a forwarder, I pass back an answer whose leg cannot be read and the peer rejects it as malformed', async () => {
    // Given
    const { peer, timers, issues, server } = await forwardToRawServer();
    const read = captureOutcome(peer.request(notes.read, 'a note'));
    await timers.advance(0);

    // When
    server.send(getHeardId(server, 'request:notes.read'), createUnreadableLeg(notes.read));
    await timers.advance(0);

    // Then
    expect(await read).toBeInstanceOf(TransportMalformedResponseError);
    expect(issues).toEqual([matchRefusedIssue('malformed')]);
  });

  it("As a forwarder, I wait on the upstream's handshake until it times out and answer the waiting call HostFailure", async () => {
    // Given an upstream whose server never answers the handshake
    const near = createRig();
    const far = createRawRig({ handshake: 'offer' });
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
    expect(far.peer.getNames().filter(name => name !== 'handshakeOffer')).toEqual([]);
    expect(near.issues).toEqual([]);
  });

  it('As a forwarder, I answer a peer message whose leg cannot be read MalformedFrame and forward nothing', async () => {
    // Given
    const near = createRawRig({ handshake: 'respond' });
    const far = createRig();
    near.transport.forward([notes.read], far.opener);
    near.openHandshake();
    await near.timers.advance(0);

    // When
    near.peer.send(1, createUnreadableLeg(notes.read));
    await near.timers.advance(0);

    // Then
    expect(near.peer.getFailures()).toEqual([{ id: 1, value: matchFields<Failure>({ tag: 'MalformedFrame' }) }]);
    expect(near.issues).toEqual([matchRefusedIssue('malformed')]);
    expect(far.delivered).toEqual([]);
  });

  it('As a forwarder, I refuse a response or a value the peer sends on a forwarded method and forward neither', async () => {
    // Given
    const near = createRawRig({ handshake: 'respond' });
    const far = createRig();
    const { starts, stops } = serveWatch(far.accepter);
    near.transport.forward([notes.read, notes.watch], far.opener);
    near.openHandshake();
    await near.timers.advance(0);
    near.peer.call({ method: notes.watch, id: 3, message: { tag: 'start', value: 'from the top' } });
    await far.timers.advance(0);

    // When
    near.peer.call({ method: notes.read, id: 1, message: { tag: 'response', value: ok('not asked') } });
    near.peer.call({ method: notes.watch, id: 3, message: { tag: 'receive', value: 'backwards' } });
    await far.timers.advance(0);

    // Then
    const invalid = matchRefusedIssue('invalid');
    expect(near.issues).toEqual([invalid, invalid]);
    expect(getFrameNames(far.delivered)).toEqual(['handshakeOffer', 'handshakeResponse', 'start:notes.watch']);
    expect([starts, stops]).toEqual([['from the top'], [0]]);
    expect(near.peer.getNames()).toEqual(['handshakeResponse']);
  });

  it('As a forwarder, I refuse the wrong legs the upstream sends on forwarded calls and pass none back', async () => {
    // Given
    const { peer, timers, issues, server, toPeer } = await forwardToRawServer();
    const read = peer.request(notes.read, 'a note');
    const heard = createWatcher();
    peer.subscribe({ method: notes.watch, start: 'from the top', listeners: heard });
    await timers.advance(0);
    const readId = getHeardId(server, 'request:notes.read');
    const watchId = getHeardId(server, 'start:notes.watch');

    // When the server sends the wrong legs, then the right ones
    server.call({ method: notes.read, id: readId, message: { tag: 'request', value: 'backwards' } });
    server.call({ method: notes.watch, id: watchId, message: { tag: 'start', value: 'backwards' } });
    server.call({ method: notes.watch, id: watchId, message: { tag: 'stop', value: undefined } });
    await timers.advance(0);
    server.call({ method: notes.read, id: readId, message: { tag: 'response', value: ok('the note') } });
    server.call({ method: notes.watch, id: watchId, message: { tag: 'receive', value: 'a value' } });
    await timers.advance(0);

    // Then only the right ones reach the peer
    const invalid = matchRefusedIssue('invalid');
    expect(issues).toEqual([invalid, invalid, invalid]);
    expect(await read).toEqual(ok('the note'));
    expect(heard.values).toEqual(['a value']);
    expect([heard.ends, heard.fails, heard.closes]).toEqual([[], [], []]);
    expect(getFrameNames(toPeer)).toEqual([
      'handshakeOffer',
      'handshakeResponse',
      'request:notes.read',
      'start:notes.watch',
      'response:notes.read',
      'receive:notes.watch',
    ]);
  });

  it('As a schema user, I forward to a transport that places the method elsewhere, to one this library did not build, or for a method that already has a handler, and am refused', () => {
    // Given
    const { forwarder, upstream } = createForwardRig();
    const reordered = defineSchema({ version: VERSION, hello: str, sections: { echo, notes } });
    const elsewhere = createTransport({
      schema: reordered,
      provider: createProviderPair().left,
      handshake: 'offer',
      hello: 'elsewhere',
    });

    // When each is forwarded, and then the owner serves the method every refused call named
    const toElsewhere = catchError(() => forwarder.forward([notes.touch], elsewhere));
    const toAnother = catchError(() => forwarder.forward([notes.touch], { ...upstream }));
    const twice = catchError(() => forwarder.forward([notes.touch, notes.read], upstream));
    const served = catchError(() => forwarder.handleRequest(notes.touch, () => ok()));

    // Then nothing a refused call names stays forwarded
    expect(toElsewhere).toEqual(matchFields<Error>({ message: 'notes.touch sits elsewhere in the upstream' }));
    expect(toAnother).toEqual(matchFields<Error>({ message: 'The upstream transport was not built by this library' }));
    expect(twice).toEqual(matchFields<Error>({ message: 'notes.read already has a handler' }));
    expect(served).toBeUndefined();
  });
});

/** The ids of the subscriptions a raw peer heard start, in order. */
function getStartIds(peer: RawPeer): number[] {
  return peer.find('start:notes.watch').map(message => message.id);
}

/** Opens a transport toward a raw peer and answers its handshake. */
async function connectRawRig(params: Omit<RawRigParams, 'handshake'> = {}) {
  const raw = createRawRig({ ...params, handshake: 'offer' });
  raw.transport.connect();
  await raw.timers.advance(0);
  raw.answerHandshake();
  await raw.transport.whenConnected();
  return raw;
}

/** Makes a transport that accepted a raw peer's handshake. */
async function acceptRawRig(params: Omit<RawRigParams, 'handshake'> = {}) {
  const raw = createRawRig({ ...params, handshake: 'respond' });
  raw.openHandshake();
  await raw.timers.advance(0);
  return raw;
}

/** Builds a message on the method at `at` whose leg no method reads, as the frame body a raw side posts. */
function createUnreadableLeg(at: AnyMethod) {
  const { sectionId, methodId } = testSchema.addressOf(at);
  return { tag: 'call' as const, value: { sectionId, methodId, message: UNKNOWN_LEG } };
}

/**
 * Connects a peer to a forwarder whose upstream faces a raw server the test speaks for, both handshakes over.
 * `toPeer` is what the peer's channel delivered, both ways.
 */
async function forwardToRawServer() {
  const near = createRig();
  const far = createRawRig({ handshake: 'offer' });
  near.accepter.forward([notes.read, notes.watch, echo.say], far.transport);
  near.opener.connect();
  far.transport.connect();
  await near.timers.advance(0);
  far.answerHandshake();
  await far.transport.whenConnected();
  return { peer: near.opener, timers: near.timers, issues: near.issues, server: far.peer, toPeer: near.delivered };
}

/**
 * Accepts a raw peer on a forwarder whose upstream faces a server that answers `notes.read` once the test resolves it.
 */
async function forwardFromRawPeer() {
  const near = createRawRig({ handshake: 'respond' });
  const far = createRig();
  const answer = createDeferred<ResultPayload<string, CallError<string>>>();
  const served = vi.fn(() => answer.promise);
  far.accepter.handleRequest(notes.read, served);
  near.transport.forward([notes.read, notes.watch], far.opener);
  near.openHandshake();
  await near.timers.advance(0);
  return { ...near, server: far.accepter, answer, served };
}

/** Gets the id of the one call the raw server heard by `name`, such as `request:notes.read`. */
function getHeardId(server: RawPeer, name: string): number {
  return must(server.find(name)[0], name).id;
}
