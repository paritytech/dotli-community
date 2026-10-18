// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest';
import { bindLogSink } from '@dotli/shared';
import { manualTimers } from '@dotli/shared/testing';
import { createProviderPair } from './provider.fake.js';
import type { Provider } from './provider.js';
import { none } from './codec.js';
import { ok, type CallError, type Result } from './result.js';
import { defineSchema, request } from './schema.js';
import type { CallContext } from './serving.js';
import { NOTES, TOUCH, VERSION, WATCH, issueLog, rawRig, rig, testSchema, type TestSchema } from './testing/rig.js';
import { createTransport, type RequestHandler, type Transport, type TransportOptions } from './transport.js';
import { encodeMessage, type WireMessage } from './wire.js';

/** Collects what the shared log records as errors. */
function errorLog(): string[] {
  const errors: string[] = [];
  onTestFinished(
    bindLogSink({
      emit: (level, message) => {
        if (level === 'error') {
          errors.push(message);
        }
      },
    }),
  );
  return errors;
}

describe('createTransport', () => {
  it('As a schema author, I pass a hello exactly when my schema declares one, and my calls are typed from the schema', () => {
    // Given
    const plain = defineSchema({
      version: 1,
      traits: { notes: { touch: request({ request: none, response: none }) } },
    });
    type Notes = Transport<TestSchema>;

    // When a transport over the schema with no hello is made without one
    const withoutHello = (): void => {
      createTransport(plain, createProviderPair().left, { handshake: 'accept' }).dispose(new Error('done'));
    };

    // Then
    expectTypeOf<{ handshake: 'open'; hello: string }>().toExtend<TransportOptions<TestSchema>>();
    expectTypeOf<{ handshake: 'open' }>().not.toExtend<TransportOptions<TestSchema>>();
    expectTypeOf<{ handshake: 'accept' }>().toExtend<TransportOptions<typeof plain>>();
    expectTypeOf<{ handshake: 'accept'; hello: string }>().not.toExtend<TransportOptions<typeof plain>>();
    expectTypeOf<RequestHandler<TestSchema, 'notes', 'read'>>().toEqualTypeOf<
      (
        payload: string,
        context: CallContext<TestSchema>,
      ) => Result<string, CallError<string>> | PromiseLike<Result<string, CallError<string>>>
    >();
    expectTypeOf<CallContext<TestSchema>['hello']>().toEqualTypeOf<string>();
    const typeOnly = (transport: Notes): void => {
      expectTypeOf(transport.request('notes', 'read', 'a note')).resolves.toEqualTypeOf<
        Result<string, CallError<string>>
      >();
      // @ts-expect-error a subscription is not a request
      void transport.request('notes', 'watch', 'from the top');
      // @ts-expect-error the payload is text
      void transport.request('echo', 'say', 1);
    };
    expect(typeOnly).toBeTypeOf('function');
    expect(withoutHello).not.toThrow();
  });

  it('As a peer, I serve and call over the same transport, and both directions work at once', async () => {
    // Given
    const { opener, accepter, timers, issues } = rig();
    opener.handleRequest('echo', 'say', (text, { hello }) => ok(`the opener heard ${text} from the ${hello}`));
    accepter.handleRequest('echo', 'say', (text, { hello }) => ok(`the accepter heard ${text} from the ${hello}`));
    const fromAccepter = accepter.request('echo', 'say', 'ping');
    const fromOpener = opener.request('echo', 'say', 'pong');

    // When
    opener.connect();
    await timers.advance(0);

    // Then
    expect(await fromOpener).toEqual(ok('the accepter heard pong from the opener'));
    expect(await fromAccepter).toEqual(ok('the opener heard ping from the accepter'));
    expect(issues).toEqual([]);
  });

  it('As a receiver, data that is not bytes is refused as not_bytes', () => {
    // Given
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
    const { issues, onIssue } = issueLog();
    createTransport(testSchema, provider, { handshake: 'accept', hello: 'accepter', onIssue });

    // When a provider of the owner's hands over text
    for (const listener of listeners) {
      listener('no bytes' as unknown as ArrayBuffer);
    }

    // Then
    expect(issues).toEqual([{ kind: 'refused', reason: 'not_bytes', cause: expect.any(TypeError) as TypeError }]);
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
    transport.handleRequest('notes', 'touch', () => ok());
    const hear = (message: WireMessage): void => {
      for (const listener of listeners) {
        listener(encodeMessage(testSchema, message));
      }
    };
    hear({ kind: 'handshake', leg: 'request', id: 1, version: VERSION, hello: 'peer' });

    // When
    const call = (): void => {
      hear({ kind: 'method', leg: 'request', id: 2, trait: NOTES, method: TOUCH, payload: undefined });
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
      '[transport] A message was refused as malformed, RangeError: expected a 7-byte header, got 3 bytes',
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
    peer.send({ kind: 'method', leg: 'receive', id: 40, trait: NOTES, method: WATCH, payload: 'a line' });
    peer.send({ kind: 'method', leg: 'interrupt', id: 40, trait: NOTES, method: WATCH, outcome: ok() });
    await timers.advance(0);

    // Then
    expect(issues).toEqual([
      { kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error },
      { kind: 'refused', reason: 'invalid', cause: expect.any(Error) as Error },
    ]);
    expect(peer.legs()).toEqual(['request:255.0']);
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
      '[transport] A message was refused as malformed, RangeError: expected a 7-byte header, got 3 bytes',
    );
    expect(errors[1]).toMatch(/^\[transport\] A request message could not be posted, Error: x+$/);
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
