// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { type ResultPayload, str } from 'scale-ts';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { manualTimers } from '@dotli/shared/testing';
import { createProviderPair } from './provider.fake.js';
import type { Provider } from './provider.js';
import { err, hostFailure, ok, type CallError } from './result.js';
import type { CallContext, Sink } from './serving.js';
import {
  echo,
  errorLog,
  issueLog,
  notes,
  rawRig,
  rig,
  serveWatch,
  testSchema,
  VERSION,
  watcher,
} from './testing/rig.js';
import { createTransport, type Transport, type TransportOptions } from './transport.js';
import { encodeFrame, frame } from './wire.js';

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
    const errors = errorLog();
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
    expect(errors).toEqual([
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
    const errors = errorLog();
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
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(
      '[transport] A message was refused as malformed, RangeError: Offset is outside the bounds of the DataView',
    );
    expect(errors[1]).toMatch(/^\[transport\] A message could not be posted, Error: x+$/);
    expect(errors[1]).toHaveLength(200);
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
