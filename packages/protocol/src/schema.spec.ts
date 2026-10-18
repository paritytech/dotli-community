// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, expectTypeOf, it } from 'vitest';
import { manualTimers } from '@dotli/shared/testing';
import {
  createTransport,
  domain,
  err,
  ok,
  type CallError,
  type DomainError,
  type MethodName,
  type MethodTypes,
  type Result,
  type Sink,
  type SubscriptionHandle,
  type TraitName,
} from '@dotli/transport';
import { MessageRefusedError, createProviderPair, describeMessage } from '@dotli/transport/testing';
import { protocolSchema, type ProtocolSchema } from './schema.js';

type S = ProtocolSchema;

/** What one method sends in a test: a request with each answer it tries, or a start with its values and each end. */
type SampleOf<T extends TraitName<S>, M extends MethodName<S, T>> =
  MethodTypes<S, T, M> extends { request: infer P; response: infer R }
    ? { request: P; responses: R[] }
    : MethodTypes<S, T, M> extends { start: infer St; receive: infer V; interrupt: infer I }
      ? { start: St; values: V[]; interrupts: I[] }
      : never;

// Typed against the schema, so a method without a sample, or a sample of the wrong shape, fails to compile.
type Samples = { [T in TraitName<S>]: { [M in MethodName<S, T>]: SampleOf<T, M> } };

type AnySample =
  | { request: unknown; responses: unknown[] }
  | { start: unknown; values: unknown[]; interrupts: Result<void, CallError<unknown>>[] };

/** The transport with its names and payloads untyped, so a test can walk the schema by its sample table. */
interface LooseTransport {
  request(trait: string, method: string, payload: unknown): Promise<unknown>;
  handleRequest(
    trait: string,
    method: string,
    handler: (payload: unknown, context: { hello: unknown }) => unknown,
  ): void;
  subscribe(
    trait: string,
    method: string,
    start: unknown,
    listeners: { receive(value: unknown): void; interrupt(outcome: Result<void, CallError<unknown>>): void },
  ): SubscriptionHandle;
  handleSubscription(
    trait: string,
    method: string,
    handler: (start: unknown, context: { hello: unknown }, sink: Sink<unknown, unknown>) => () => void,
  ): void;
}

const siteKey = { siteId: 'app.dot', key: 'session' };
const siteKeyValue = { ...siteKey, value: 'token' };
const syncTimeout = domain({ tag: 'syncTimeout' as const, value: 'Asset Hub did not sync in time' });
const apiStopped = domain({ tag: 'apiStopped' as const, value: 'The light client stopped' });

const samples: Samples = {
  frame: {
    status: {
      start: undefined,
      values: [undefined],
      interrupts: [
        ok(),
        err(domain({ tag: 'fatal', value: 'smoldot panicked' })),
        err(domain({ tag: 'initFailed', value: 'the database did not open' })),
        err(domain({ tag: 'released', value: 'the port was released' })),
      ],
    },
    heartbeat: { request: undefined, responses: [ok()] },
    beat: { start: undefined, values: [undefined, undefined], interrupts: [ok()] },
    warmup: { request: undefined, responses: [ok()] },
    telemetry: {
      start: undefined,
      values: [
        { tag: 'chainSync', value: { chain: 'relay', kind: 'peers', peers: 8, isSyncing: true } },
        {
          tag: 'chainDetail',
          value: { chain: 'assethub', dbCache: 'hit', peers: [{ peerId: '12D3KooW', roles: 'full', bestNumber: 42 }] },
        },
        { tag: 'netBytes', value: 1_048_576 },
        { tag: 'smoldotDb', value: { chain: 'bulletin', outcome: 'miss' } },
      ],
      interrupts: [ok()],
    },
  },
  resolve: {
    owner: { request: { label: 'app' }, responses: [ok('5Grwva'), ok(null), err(syncTimeout), err(apiStopped)] },
    executableManifest: {
      request: { label: 'app', kind: 'worker' },
      responses: [
        ok({
          kind: 'ok',
          value: { $v: 1, kind: 'worker', appVersion: [1, 2, 3], entrypoint: 'main.js', includes: { chat: true } },
          raw: '{"kind":"worker"}',
        }),
        ok({ kind: 'empty' }),
        err(apiStopped),
      ],
    },
    rootManifest: {
      request: { label: 'app' },
      responses: [
        ok({
          kind: 'ok',
          value: { $v: 1, displayName: 'App', description: 'An app', icon: { cid: 'bafy', format: 'png' } },
          raw: '{"displayName":"App"}',
        }),
        err(syncTimeout),
      ],
    },
    dotName: {
      start: { label: 'app' },
      values: [
        { tag: 'phase', value: 'asset-hub-syncing' },
        { tag: 'resolved', value: 'bafycontent' },
        { tag: 'resolved', value: null },
      ],
      interrupts: [ok(), err(syncTimeout), err(apiStopped)],
    },
  },
  storage: {
    authRead: { request: siteKey, responses: [ok('token'), ok(null)] },
    authWrite: { request: siteKeyValue, responses: [ok()] },
    authClear: { request: siteKey, responses: [ok()] },
    authChanges: {
      start: undefined,
      values: [siteKeyValue, { ...siteKey, value: null }],
      interrupts: [ok()],
    },
    modeRead: { request: siteKey, responses: [ok('wallet'), ok(null)] },
    modeWrite: { request: siteKeyValue, responses: [ok()] },
    modeClear: { request: siteKey, responses: [ok()] },
  },
  wallet: {
    read: {
      request: { siteId: 'app.dot' },
      responses: [
        ok({ tag: 'none', value: undefined }),
        ok({ tag: 'unreadable', value: undefined }),
        ok({
          tag: 'ok',
          value: { entropy: Uint8Array.of(1, 2, 3), identity: { identityAccountId: '5Grwva', liteUsername: null } },
        }),
        ok({ tag: 'ok', value: { entropy: Uint8Array.of(4, 5, 6), identity: null } }),
      ],
    },
    save: { request: { siteId: 'app.dot', entropy: Uint8Array.of(9, 8, 7) }, responses: [ok()] },
    identity: {
      request: { siteId: 'app.dot', identity: { identityAccountId: '5Grwva', liteUsername: 'alice' } },
      responses: [ok()],
    },
    forget: { request: { siteId: 'app.dot' }, responses: [ok()] },
  },
  chain: {
    send: { request: { connectionId: 'c1', message: '{"jsonrpc":"2.0","id":1}' }, responses: [ok()] },
    connect: {
      start: { genesisHash: '0x91b171bb', connectionId: 'c1' },
      values: [
        { tag: 'connected', value: undefined },
        { tag: 'message', value: '{"jsonrpc":"2.0","id":1,"result":null}' },
      ],
      interrupts: [ok(), err(apiStopped)],
    },
  },
};

const OPENER_HELLO = { resolutionId: 'resolution-1' };
const ACCEPTER_HELLO = { resolutionId: null };

/** An opener on the left and an accepter on the right of one in-memory channel, both over the protocol schema. */
function protocolRig() {
  const { left, right, delivered } = createProviderPair();
  const opener = createTransport(protocolSchema, left, {
    handshake: 'open',
    hello: OPENER_HELLO,
    timers: manualTimers(),
  });
  const accepter = createTransport(protocolSchema, right, { handshake: 'accept', hello: ACCEPTER_HELLO });
  return { opener, accepter, delivered };
}

/** Subscribes once and settles with the values heard and the one end. */
async function heardUntilEnd(transport: LooseTransport, trait: string, method: string, start: unknown) {
  const values: unknown[] = [];
  const end = await new Promise<Result<void, CallError<unknown>>>(resolve => {
    transport.subscribe(trait, method, start, {
      receive: value => values.push(value),
      interrupt: resolve,
    });
  });
  return { values, end };
}

function entries(): [string, string, AnySample][] {
  return Object.entries(samples).flatMap(([trait, methods]) =>
    Object.entries(methods as Record<string, AnySample>).map(([method, sample]): [string, string, AnySample] => [
      trait,
      method,
      sample,
    ]),
  );
}

describe('protocolSchema', () => {
  it('As the protocol, every method round trips its values through the schema', async () => {
    // Given an opener and an accepter that serves every method with its samples
    const { opener, accepter, delivered } = protocolRig();
    const caller: LooseTransport = opener;
    const server: LooseTransport = accepter;
    const hellos: unknown[] = [];
    for (const [trait, method, sample] of entries()) {
      if ('request' in sample) {
        let run = 0;
        server.handleRequest(trait, method, (_payload, context) => {
          hellos.push(context.hello);
          return sample.responses[run++];
        });
      } else {
        let run = 0;
        server.handleSubscription(trait, method, (_start, context, sink) => {
          hellos.push(context.hello);
          for (const value of sample.values) {
            sink.receive(value);
          }
          const end = sample.interrupts[run++];
          if (end?.ok === false) {
            sink.interrupt(end.error);
          } else {
            sink.interrupt();
          }
          return () => undefined;
        });
      }
    }
    opener.connect();
    await opener.whenConnected();

    // When every method is called with each of its samples
    const heard = new Map<string, unknown[]>();
    for (const [trait, method, sample] of entries()) {
      const outcomes: unknown[] = [];
      if ('request' in sample) {
        for (const _ of sample.responses) {
          outcomes.push(await caller.request(trait, method, sample.request));
        }
      } else {
        for (const _ of sample.interrupts) {
          outcomes.push(await heardUntilEnd(caller, trait, method, sample.start));
        }
      }
      heard.set(`${trait}.${method}`, outcomes);
    }

    // Then each side reads what the other sent, and the recorded messages carry the same values
    const described = delivered.map(data => describeMessage(protocolSchema, data));
    for (const [trait, method, sample] of entries()) {
      const address = `${trait}.${method}`;
      const messages = described
        .filter(message => `${message.trait}.${message.method}` === address)
        .map(({ leg, body }) => ({ leg, body }));
      if ('request' in sample) {
        expect(heard.get(address), address).toEqual(sample.responses);
        expect(messages, address).toEqual(
          sample.responses.flatMap(response => [
            { leg: 'request', body: sample.request },
            { leg: 'response', body: response },
          ]),
        );
      } else {
        expect(heard.get(address), address).toEqual(sample.interrupts.map(end => ({ values: sample.values, end })));
        expect(messages, address).toEqual(
          sample.interrupts.flatMap(end => [
            { leg: 'start', body: sample.start },
            ...sample.values.map(value => ({ leg: 'receive', body: value })),
            { leg: 'interrupt', body: end },
          ]),
        );
      }
    }
    // Every call and every start reached a handler that read the opener's hello.
    expect(hellos).toEqual([...heard.values()].flat().map(() => OPENER_HELLO));
    // The handshake is the library's own, so it is every message outside the protocol's traits.
    const traits = new Set(Object.keys(samples));
    const handshake = described.filter(message => !traits.has(message.trait)).map(({ leg, body }) => ({ leg, body }));
    expect(handshake).toEqual([
      { leg: 'request', body: { version: 2, hello: OPENER_HELLO } },
      { leg: 'response', body: ok(ACCEPTER_HELLO) },
    ]);
  });

  it('As a facade, I match a remote failure by its tag, not by a remote error name', () => {
    // Given the failure types of the frame status and the resolve methods
    type FrameFailure = DomainError<S, 'frame', 'status'>;
    type RemoteFailure = DomainError<S, 'resolve', 'owner'>;

    // Then
    expectTypeOf<FrameFailure>().toEqualTypeOf<
      { tag: 'fatal'; value: string } | { tag: 'initFailed'; value: string } | { tag: 'released'; value: string }
    >();
    expectTypeOf<RemoteFailure>().toEqualTypeOf<
      { tag: 'syncTimeout'; value: string } | { tag: 'apiStopped'; value: string }
    >();
    expectTypeOf<DomainError<S, 'resolve', 'executableManifest'>>().toEqualTypeOf<RemoteFailure>();
    expectTypeOf<DomainError<S, 'resolve', 'rootManifest'>>().toEqualTypeOf<RemoteFailure>();
    expectTypeOf<DomainError<S, 'resolve', 'dotName'>>().toEqualTypeOf<RemoteFailure>();
    expectTypeOf<DomainError<S, 'chain', 'connect'>>().toEqualTypeOf<RemoteFailure>();
    expectTypeOf<DomainError<S, 'chain', 'send'>>().toBeNever();
    expectTypeOf<DomainError<S, 'storage', 'authRead'>>().toBeNever();
  });

  it('As the protocol, a value codec decodes a payload that sits after a header in the message', async () => {
    // Given a recorded owner request, whose label sits after the header in its buffer
    const { opener, accepter, delivered } = protocolRig();
    accepter.handleRequest('resolve', 'owner', ({ label }) => ok(`owner of ${label}`));
    opener.connect();

    // When
    const answer = await opener.request('resolve', 'owner', { label: 'app' });

    // Then
    expect(answer).toEqual(ok('owner of app'));
    const request = delivered
      .map(data => describeMessage(protocolSchema, data))
      .find(message => message.method === 'owner' && message.leg === 'request');
    expect(request?.body).toEqual({ label: 'app' });
  });

  it('As the protocol, a value codec refuses a payload with bytes after its value', async () => {
    // Given a recorded owner request with one byte appended
    const { opener, accepter, delivered } = protocolRig();
    accepter.handleRequest('resolve', 'owner', () => ok(null));
    opener.connect();
    await opener.request('resolve', 'owner', { label: 'app' });
    const recorded = delivered.find(data => describeMessage(protocolSchema, data).method === 'owner');
    if (recorded === undefined) {
      throw new Error('no owner request was recorded');
    }
    const padded = new Uint8Array(recorded.byteLength + 1);
    padded.set(new Uint8Array(recorded));

    // When
    const decodePadded = (): unknown => describeMessage(protocolSchema, padded.buffer);

    // Then
    expect(decodePadded).toThrow(/refused as malformed/);
  });

  it('As the protocol, an invalid telemetry event is refused', async () => {
    // Given a frame that sends a valid event, then a peer list past the limit
    const { opener, accepter, delivered } = protocolRig();
    const tooManyPeers = Array.from({ length: 51 }, (_, index) => ({
      peerId: `peer-${String(index)}`,
      roles: 'full',
      bestNumber: index,
    }));
    accepter.handleSubscription('frame', 'telemetry', (_start, _context, sink) => {
      sink.receive({ tag: 'netBytes', value: 512 });
      sink.receive({ tag: 'chainDetail', value: { chain: 'relay', peers: tooManyPeers } });
      // Ends cleanly, so an event let through would end the subscription as Ok.
      sink.interrupt();
      return () => undefined;
    });
    opener.connect();

    // When
    const { values, end } = await heardUntilEnd(opener, 'frame', 'telemetry', undefined);

    // Then
    expect(values).toEqual([{ tag: 'netBytes', value: 512 }]);
    expect(end).toEqual(err({ tag: 'MalformedFrame', reason: 'a chainDetail event is past the telemetry limits' }));
    const refusals = delivered.flatMap(data => {
      try {
        describeMessage(protocolSchema, data);
        return [];
      } catch (error) {
        return [error];
      }
    });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toBeInstanceOf(MessageRefusedError);
    expect((refusals[0] as MessageRefusedError).reason).toBe('malformed');
  });
});
