// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, expectTypeOf, it } from 'vitest';
import { toError } from '@dotli/shared';
import { manualTimers } from '@dotli/shared/testing';
import {
  createTransport,
  domain,
  err,
  hostFailure,
  malformedFrame,
  ok,
  type AnyMethod,
  type CallError,
  type DomainError,
  type Request,
  type ResultPayload,
  type Subscription,
  type TransportIssue,
  type TransportVersions,
} from '@dotli/transport';
import {
  FrameRefusedError,
  createProviderPair,
  messagesOf,
  readFrame,
  recordMessage,
  type RecordedWireMessage,
} from '@dotli/transport/testing';
import {
  isLocalWalletEntropy,
  isLocalWalletIdentity,
  protocolSchema,
  type DomainFailure,
  type FrameFailure,
  type ProtocolHello,
  type ProtocolSchema,
  type ProtocolTransport,
  type SubscriptionEnd,
} from './schema.js';
import { endListeners } from './subscription.js';

const { frame, resolve, storage, wallet, chain } = protocolSchema.sections;

type Sections = ProtocolSchema['sections'];

/** What a call heard: how many calls it made, and the check of what they heard and sent. */
interface Heard {
  calls: number;
  check(recorded: RecordedWireMessage[]): void;
}

/** One method with its samples: served by the accepter, then called by the opener once per sample. */
interface Case {
  method: AnyMethod;
  serve(server: ProtocolTransport, hellos: ProtocolHello[]): void;
  call(caller: ProtocolTransport): Promise<Heard>;
}

// Typed against the schema, so a method without a case fails to compile.
type Cases = { [T in keyof Sections]: { [M in keyof Sections[T]]: Case } };

/** A sample that is missing, which fails the test that reads it. */
const NO_SAMPLE = hostFailure('Error: no sample left');

/** A request with each answer it tries. */
function requestCase<P, R, E>(
  method: Request<P, R, E>,
  sample: { request: NoInfer<P>; responses: ResultPayload<NoInfer<R>, CallError<NoInfer<E>>>[] },
): Case {
  return {
    method,
    serve(server, hellos) {
      let run = 0;
      server.handleRequest(method, (_payload, context) => {
        hellos.push(context.hello);
        return sample.responses[run++] ?? err(NO_SAMPLE);
      });
    },
    async call(caller) {
      const outcomes: ResultPayload<R, CallError<E>>[] = [];
      for (const _ of sample.responses) {
        outcomes.push(await caller.request(method, sample.request));
      }
      return {
        calls: outcomes.length,
        check(recorded) {
          expect(outcomes).toEqual(sample.responses);
          expect(messagesOf(protocolSchema, method, recorded)).toEqual(
            sample.responses.flatMap(response => [
              { tag: 'request', value: sample.request },
              { tag: 'response', value: response },
            ]),
          );
        },
      };
    },
  };
}

/**
 * Subscribes once and settles with the values heard and the one end, the peer's interrupt or a failure of the
 * library's, or fails with the closing error.
 */
function heardUntilEnd<S, V, E>(
  transport: ProtocolTransport,
  method: Subscription<S, V, SubscriptionEnd<E>>,
  start: NoInfer<S>,
): Promise<{ values: V[]; end: SubscriptionEnd<E> }> {
  const values: V[] = [];
  return new Promise((settle, fail) => {
    transport.subscribe(method, start, {
      receive: value => values.push(value),
      ...endListeners<E>(end => {
        settle({ values, end });
      }),
      close: fail,
    });
  });
}

/** A subscription with the values it sends before each of its ends, each a `CallError` of its reason. */
function subscriptionCase<S, V, E>(
  method: Subscription<S, V, SubscriptionEnd<E>>,
  sample: {
    start: NoInfer<S>;
    values: NoInfer<V>[];
    interrupts: SubscriptionEnd<NoInfer<E>>[];
  },
): Case {
  return {
    method,
    serve(server, hellos) {
      let run = 0;
      server.handleSubscription(method, (_start, context, sink) => {
        hellos.push(context.hello);
        for (const value of sample.values) {
          sink.send(value);
        }
        const end = sample.interrupts[run++] ?? err(NO_SAMPLE);
        if (!end.success) {
          sink.interrupt(err(end.value));
        } else {
          sink.interrupt(ok());
        }
        return () => undefined;
      });
    },
    async call(caller) {
      const heard: { values: V[]; end: SubscriptionEnd<E> }[] = [];
      for (const _ of sample.interrupts) {
        heard.push(await heardUntilEnd(caller, method, sample.start));
      }
      return {
        calls: heard.length,
        check(recorded) {
          expect(heard).toEqual(sample.interrupts.map(end => ({ values: sample.values, end })));
          expect(messagesOf(protocolSchema, method, recorded)).toEqual(
            sample.interrupts.flatMap(end => [
              { tag: 'start', value: sample.start },
              ...sample.values.map(value => ({ tag: 'receive', value })),
              { tag: 'interrupt', value: end },
            ]),
          );
        },
      };
    },
  };
}

const siteKey = { siteId: 'app.dot', key: 'session' };
const siteKeyValue = { ...siteKey, value: 'token' };
const syncTimeout = domain({ tag: 'syncTimeout' as const, value: 'Asset Hub did not sync in time' });
const apiStopped = domain({ tag: 'apiStopped' as const, value: 'The light client stopped' });

const cases: Cases = {
  frame: {
    status: subscriptionCase(frame.status, {
      start: undefined,
      values: [undefined],
      interrupts: [
        ok(),
        err(domain({ tag: 'fatal', value: 'smoldot panicked' })),
        err(domain({ tag: 'initFailed', value: 'the database did not open' })),
        err(domain({ tag: 'released', value: 'the port was released' })),
      ],
    }),
    heartbeat: requestCase(frame.heartbeat, { request: undefined, responses: [ok()] }),
    beat: subscriptionCase(frame.beat, { start: undefined, values: [undefined, undefined], interrupts: [ok()] }),
    warmup: requestCase(frame.warmup, { request: undefined, responses: [ok()] }),
    telemetry: subscriptionCase(frame.telemetry, {
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
    }),
  },
  resolve: {
    owner: requestCase(resolve.owner, {
      request: { label: 'app' },
      responses: [ok('5Grwva'), ok(null), err(syncTimeout), err(apiStopped)],
    }),
    executableManifest: requestCase(resolve.executableManifest, {
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
    }),
    rootManifest: requestCase(resolve.rootManifest, {
      request: { label: 'app' },
      responses: [
        ok({
          kind: 'ok',
          value: { $v: 1, displayName: 'App', description: 'An app', icon: { cid: 'bafy', format: 'png' } },
          raw: '{"displayName":"App"}',
        }),
        err(syncTimeout),
      ],
    }),
    dotName: subscriptionCase(resolve.dotName, {
      start: { label: 'app' },
      values: [
        { tag: 'phase', value: 'asset-hub-syncing' },
        { tag: 'resolved', value: 'bafycontent' },
        { tag: 'resolved', value: null },
      ],
      interrupts: [ok(), err(syncTimeout), err(apiStopped)],
    }),
  },
  storage: {
    authRead: requestCase(storage.authRead, { request: siteKey, responses: [ok('token'), ok(null)] }),
    authWrite: requestCase(storage.authWrite, { request: siteKeyValue, responses: [ok(true), ok(false)] }),
    authClear: requestCase(storage.authClear, { request: siteKey, responses: [ok()] }),
    authChanges: subscriptionCase(storage.authChanges, {
      start: undefined,
      values: [
        { tag: 'session', value: siteKeyValue },
        { tag: 'wallet', value: { siteId: siteKey.siteId } },
      ],
      interrupts: [ok()],
    }),
    modeRead: requestCase(storage.modeRead, { request: siteKey, responses: [ok('wallet'), ok(null)] }),
    modeWrite: requestCase(storage.modeWrite, { request: siteKeyValue, responses: [ok(true), ok(false)] }),
    modeClear: requestCase(storage.modeClear, { request: siteKey, responses: [ok()] }),
    authClearIf: requestCase(storage.authClearIf, { request: siteKeyValue, responses: [ok(true), ok(false)] }),
  },
  wallet: {
    read: requestCase(wallet.read, {
      request: { siteId: 'app.dot' },
      responses: [
        ok({ tag: 'none', value: undefined }),
        ok({ tag: 'unreadable', value: undefined }),
        ok({
          tag: 'ok',
          value: {
            entropy: Uint8Array.of(1, 2, 3),
            identity: { identityAccountId: '5Grwva', liteUsername: null },
            version: Uint8Array.of(7),
          },
        }),
        ok({ tag: 'ok', value: { entropy: Uint8Array.of(4, 5, 6), identity: null, version: Uint8Array.of(8) } }),
      ],
    }),
    save: requestCase(wallet.save, {
      request: {
        siteId: 'app.dot',
        entropy: Uint8Array.of(9, 8, 7),
        identity: { identityAccountId: '5Grwva', liteUsername: null },
      },
      responses: [ok()],
    }),
    identity: requestCase(wallet.identity, {
      request: { siteId: 'app.dot', identity: { identityAccountId: '5Grwva', liteUsername: 'alice' } },
      responses: [ok()],
    }),
    forget: requestCase(wallet.forget, { request: { siteId: 'app.dot' }, responses: [ok()] }),
    forgetIf: requestCase(wallet.forgetIf, {
      request: { siteId: 'app.dot', version: Uint8Array.of(9, 8, 7) },
      responses: [ok(true), ok(false)],
    }),
  },
  chain: {
    send: requestCase(chain.send, {
      request: { connectionId: 'c1', message: '{"jsonrpc":"2.0","id":1}' },
      responses: [ok()],
    }),
    connect: subscriptionCase(chain.connect, {
      start: { genesisHash: '0x91b171bb', connectionId: 'c1' },
      values: [
        { tag: 'connected', value: undefined },
        { tag: 'message', value: '{"jsonrpc":"2.0","id":1,"result":null}' },
      ],
      interrupts: [ok(), err(apiStopped)],
    }),
  },
};

const allCases: Case[] = Object.values(cases).flatMap(methods => Object.values(methods));

const OPENER_HELLO = { resolutionId: 'resolution-1' };
const ACCEPTER_HELLO = { resolutionId: null };

/** An opener on the left and an accepter on the right of one in-memory channel, both over the protocol schema. */
function protocolRig() {
  const { left, right, delivered } = createProviderPair();
  const issues: TransportIssue[] = [];
  const opener = createTransport(protocolSchema, left, {
    handshake: 'offer',
    hello: OPENER_HELLO,
    timers: manualTimers(),
    onIssue: issue => issues.push(issue),
  });
  const accepter = createTransport(protocolSchema, right, { handshake: 'respond', hello: ACCEPTER_HELLO });
  return { opener, accepter, delivered, issues };
}

/** A handshake frame with its hello decoded. */
type HandshakeFrame =
  | { handshakeOffer: { version: number; hello: ProtocolHello } }
  | { handshakeResponse: ResultPayload<ProtocolHello, TransportVersions> };

/** The handshake frames in `delivered`. */
function handshakeOf(delivered: Uint8Array[]): HandshakeFrame[] {
  return delivered.flatMap((data): HandshakeFrame[] => {
    const read = readFrame(protocolSchema, data);
    switch (read.kind) {
      case 'handshakeOffer':
        return [
          {
            handshakeOffer: { version: read.value.versions.schema, hello: protocolSchema.hello.dec(read.value.hello) },
          },
        ];
      case 'handshakeResponse':
        return [
          {
            handshakeResponse: read.value.success
              ? ok(protocolSchema.hello.dec(read.value.value))
              : err(read.value.value),
          },
        ];
      case 'failed':
      case 'call':
        return [];
    }
  });
}

describe('protocolSchema', () => {
  it('As the protocol, every method round trips its values through the schema', async () => {
    // Given an opener and an accepter that serves every method with its samples
    const { opener, accepter, delivered } = protocolRig();
    const hellos: ProtocolHello[] = [];
    for (const sample of allCases) {
      sample.serve(accepter, hellos);
    }
    opener.connect();
    await opener.whenConnected();

    // When every method is called with each of its samples
    const heard: Heard[] = [];
    for (const sample of allCases) {
      heard.push(await sample.call(opener));
    }

    // Then each side reads what the other sent, and the recorded messages carry the same values
    expect(allCases.map(sample => sample.method)).toEqual(
      Object.values(protocolSchema.sections).flatMap((section: Readonly<Record<string, AnyMethod>>) =>
        Object.values(section),
      ),
    );
    const recorded = delivered.flatMap(data => recordMessage(protocolSchema, data) ?? []);
    for (const calls of heard) {
      calls.check(recorded);
    }
    // Every call and every start reached a handler that read the opener's hello.
    const callCount = heard.reduce((sum, calls) => sum + calls.calls, 0);
    expect(hellos).toEqual(Array.from({ length: callCount }, () => OPENER_HELLO));
    // The handshake is the library's own, so its frames carry no call.
    expect(handshakeOf(delivered)).toEqual([
      { handshakeOffer: { version: protocolSchema.version, hello: OPENER_HELLO } },
      { handshakeResponse: ok(ACCEPTER_HELLO) },
    ]);
  });

  it('As a page, I save a wallet without an identity and it round trips with a null identity', async () => {
    // Given an accepter that serves the save and an opener that sends one without an identity
    const { opener, accepter, delivered } = protocolRig();
    const save = requestCase(wallet.save, {
      request: { siteId: 'app.dot', entropy: Uint8Array.of(9, 8, 7), identity: null },
      responses: [ok()],
    });
    save.serve(accepter, []);
    opener.connect();
    await opener.whenConnected();

    // When the save is sent
    const heard = await save.call(opener);

    // Then the answer and the recorded messages carry the null identity
    heard.check(delivered.flatMap(data => recordMessage(protocolSchema, data) ?? []));
  });

  it('As a facade, I match a remote failure by its tag, not by a remote error name', () => {
    // Given the failure types of the frame status and the resolve methods
    type RemoteFailure = DomainError<typeof resolve.owner>;

    // Then
    expectTypeOf<FrameFailure>().toEqualTypeOf<
      | { tag: 'fatal'; value: string }
      | { tag: 'initFailed'; value: string }
      | { tag: 'released'; value: string }
      | { tag: 'versionMismatch'; value: string }
    >();
    expectTypeOf<RemoteFailure>().toEqualTypeOf<
      { tag: 'syncTimeout'; value: string } | { tag: 'apiStopped'; value: string }
    >();
    expectTypeOf<DomainFailure>().toEqualTypeOf<FrameFailure | RemoteFailure | undefined>();
    expectTypeOf<DomainError<typeof resolve.executableManifest>>().toEqualTypeOf<RemoteFailure>();
    expectTypeOf<DomainError<typeof resolve.rootManifest>>().toEqualTypeOf<RemoteFailure>();
    expectTypeOf<DomainError<typeof frame.status>>().toEqualTypeOf<ResultPayload<undefined, CallError<FrameFailure>>>();
    expectTypeOf<DomainError<typeof resolve.dotName>>().toEqualTypeOf<
      ResultPayload<undefined, CallError<RemoteFailure>>
    >();
    expectTypeOf<DomainError<typeof chain.connect>>().toEqualTypeOf<
      ResultPayload<undefined, CallError<RemoteFailure>>
    >();
    expectTypeOf<DomainError<typeof frame.beat>>().toEqualTypeOf<ResultPayload<undefined, CallError<undefined>>>();
    expectTypeOf<DomainError<typeof chain.send>>().toBeUndefined();
    expectTypeOf<DomainError<typeof storage.authRead>>().toBeUndefined();
  });

  it("As the protocol, each subscription's interrupt keeps truapi's CallError bytes", () => {
    // Given a clean end, a domain reason and a failure of the library's, on methods with and without a reason
    const interrupts = [
      frame.status.message.enc({ tag: 'interrupt', value: ok() }),
      frame.status.message.enc({ tag: 'interrupt', value: err(domain({ tag: 'fatal', value: 'x' })) }),
      resolve.dotName.message.enc({ tag: 'interrupt', value: err(domain({ tag: 'apiStopped', value: 'x' })) }),
      chain.connect.message.enc({ tag: 'interrupt', value: err(hostFailure('x')) }),
      frame.beat.message.enc({ tag: 'interrupt', value: err(domain(undefined)) }),
      storage.authChanges.message.enc({ tag: 'interrupt', value: err(malformedFrame('x')) }),
    ];

    // When
    const bytes = interrupts.map(data => [...data]);

    // Then the interrupt tag, the `Result`, the `CallError` and its value, as truapi lays them out
    expect(bytes).toEqual([
      [2, 0],
      [2, 1, 0, 0, 4, 0x78],
      [2, 1, 0, 1, 4, 0x78],
      [2, 1, 4, 4, 0x78],
      [2, 1, 0],
      [2, 1, 3, 4, 0x78],
    ]);
  });

  it('As the protocol, a value codec decodes a payload that sits after a header in the message', async () => {
    // Given a recorded owner request, whose label sits after the header in its buffer
    const { opener, accepter, delivered } = protocolRig();
    accepter.handleRequest(resolve.owner, ({ label }) => ok(`owner of ${label}`));
    opener.connect();

    // When
    const answer = await opener.request(resolve.owner, { label: 'app' });

    // Then
    expect(answer).toEqual(ok('owner of app'));
    const recorded = delivered.flatMap(data => recordMessage(protocolSchema, data) ?? []);
    const request = messagesOf(protocolSchema, resolve.owner, recorded).find(message => message.tag === 'request');
    expect(request?.value).toEqual({ label: 'app' });
  });

  it('As the protocol, an invalid telemetry event is refused', async () => {
    // Given a frame that sends a valid event, then a peer list past the limit
    const { opener, accepter, delivered, issues } = protocolRig();
    const tooManyPeers = Array.from({ length: 51 }, (_, index) => ({
      peerId: `peer-${String(index)}`,
      roles: 'full',
      bestNumber: index,
    }));
    accepter.handleSubscription(frame.telemetry, (_start, _context, sink) => {
      sink.send({ tag: 'netBytes', value: 512 });
      sink.send({ tag: 'chainDetail', value: { chain: 'relay', peers: tooManyPeers } });
      // Ends cleanly, so an event let through would end the subscription as Ok.
      sink.interrupt(ok());
      return () => undefined;
    });
    opener.connect();

    // When
    const { values, end } = await heardUntilEnd(opener, frame.telemetry, undefined);

    // Then
    expect(values).toEqual([{ tag: 'netBytes', value: 512 }]);
    expect(end).toEqual(err(malformedFrame('RangeError: a chainDetail event is past the telemetry limits')));
    expect(issues).toEqual([{ kind: 'refused', reason: 'malformed', cause: expect.any(RangeError) as RangeError }]);
    const refusals = delivered.flatMap(data => {
      try {
        readFrame(protocolSchema, data);
        return [];
      } catch (error) {
        return [toError(error)];
      }
    });
    expect(refusals).toEqual([expect.any(FrameRefusedError) as FrameRefusedError]);
  });
});

describe('local wallet checks', () => {
  it('As a page taking a wallet, I accept only the entropy sizes a recovery phrase has', () => {
    // Given entropy lengths from 12 to 33 bytes
    const sizes = [12, 16, 20, 24, 28, 32, 33];

    // When each is checked
    const accepted = sizes.filter(size => isLocalWalletEntropy(new Uint8Array(size)));

    // Then only the recovery phrase sizes pass
    expect(accepted).toEqual([16, 20, 24, 28, 32]);
  });

  it("As a page taking a window's wallet, I accept an identity only in the codec's shape", () => {
    // Given identities in and out of the codec's shape
    const values: unknown[] = [
      { identityAccountId: 'acc', liteUsername: null },
      { identityAccountId: 'acc', liteUsername: 'alice' },
      { identityAccountId: 'acc' },
      { identityAccountId: 1, liteUsername: null },
      null,
      ['acc'],
    ];

    // When each is checked
    const accepted = values.map(isLocalWalletIdentity);

    // Then only the two in shape pass
    expect(accepted).toEqual([true, true, false, false, false, false]);
  });
});
