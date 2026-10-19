// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A test schema and two transports over one in-memory channel, or one transport facing a raw peer the test speaks for.

import { toError, toHex } from '@dotli/shared';
import { manualTimers } from '@dotli/shared/testing';
import { Bytes, Result, _void, enhanceCodec, str, type Codec, type ResultPayload } from 'scale-ts';
import { callError, ok, type Failure, type TransportIssue } from '../errors.js';
import { createProviderPair } from '../provider.fake.js';
import type { Provider } from '../provider.js';
import { defineSchema, request, subscription, type AnyMethod } from '../schema.js';
import { createTransport, type Sink, type Transport } from '../transport.js';
import { WIRE_VERSION, frame, type Frame } from '../wire.js';
import { readFrame, type RecordedFrame } from './index.js';

export const RETRY_MS = 50;
export const TIMEOUT_MS = 5_000;
export const VERSION = 3;

/** Text that is never empty, so a test can make a payload that does not encode. */
const word = enhanceCodec(
  str,
  (value: string) => {
    if (value === '') {
      throw new RangeError('A word is never empty');
    }
    return value;
  },
  (value: string) => value,
);

export const testSchema = defineSchema({
  version: VERSION,
  hello: str,
  sections: {
    notes: {
      read: request({ request: word, response: str, error: str }),
      touch: request({ request: _void, response: _void }),
      // Its author ends it with a `Result`: `Ok` a clean end, `Err` with why.
      watch: subscription({ start: word, receive: word, interrupt: Result(_void, str) }),
    },
    echo: {
      say: request({ request: str, response: str }),
      listen: subscription({ start: _void, receive: str }),
      // An interrupt of truapi's layout, so a relay can pass a failure it heard on as the method's own reason.
      relay: subscription({ start: word, receive: word, interrupt: Result(_void, callError(str)) }),
    },
  },
});

export const { notes, echo } = testSchema.sections;

/** The wire id of the `notes` section, for a test that calls a method the section lacks. */
export const NOTES = testSchema.addressOf(notes.read).sectionId;

// `notes.read` and `notes.watch` with every payload as bytes, so a test can send what their codecs refuse.
const bytes = Bytes(Infinity);
export const rawRead = request({ request: bytes, response: bytes, error: bytes });
export const rawWatch = subscription({ start: bytes, receive: bytes, interrupt: Result(_void, bytes) });

/** A message whose leg tag no method has, so every method's leg reader refuses it. */
export const UNKNOWN_LEG = Uint8Array.of(9);

/** Text cut short: its length says two bytes and none follow, so `str` refuses it. */
export const CUT_SHORT_TEXT = Uint8Array.of(8);

/** A subscription's stop followed by a byte it leaves unread, so a whole decode refuses it. */
export const TRAILED_STOP = Uint8Array.of(...notes.watch.message.enc({ tag: 'stop', value: undefined }), 0);

/** The text `a` followed by a byte it leaves unread, so a whole decode refuses it. */
export const TRAILED_TEXT = Uint8Array.of(4, 0x61, 0);

/** Why a whole decode refuses `TRAILED_TEXT`. */
export const TRAILED_REASON = 'RangeError: The value is followed by unread bytes, 1 in all';

/**
 * Listeners of a subscription whose values are text and whose interrupt is `I`, such as `notes.watch`, that record the
 * values it hears, its interrupts, its failures and its closes.
 */
export function watcher<I = ResultPayload<undefined, string>>() {
  const values: string[] = [];
  const ends: I[] = [];
  const fails: Failure[] = [];
  const closes: Error[] = [];
  return {
    values,
    ends,
    fails,
    closes,
    receive: (value: string) => {
      values.push(value);
    },
    interrupt: (reason: I) => {
      ends.push(reason);
    },
    fail: (failure: Failure) => {
      fails.push(failure);
    },
    close: (error: Error) => {
      closes.push(error);
    },
  };
}

/** Serves `notes.watch` on a transport, keeping each subscription's start and sink and counting its stops. */
export function serveWatch(transport: Transport<string>) {
  const starts: string[] = [];
  const sinks: Sink<string, ResultPayload<undefined, string>>[] = [];
  const stops: number[] = [];
  transport.handleSubscription(notes.watch, (start, _context, sink) => {
    const index = sinks.length;
    starts.push(start);
    sinks.push(sink);
    stops.push(0);
    return () => {
      stops[index] = (stops[index] ?? 0) + 1;
    };
  });
  return { starts, sinks, stops };
}

/** Records every issue a transport hands its owner. */
export function issueLog() {
  const issues: TransportIssue[] = [];
  return { issues, onIssue: (issue: TransportIssue) => issues.push(issue) };
}

/** What a test may set on the transport of `rawRig`. */
interface WatchedSide {
  /** Replaces the issue log, which then stays empty. */
  onIssue?: (issue: TransportIssue) => void;
  timeoutMs?: number | null;
}

/** An opener on the left and an accepter on the right, over one in-memory channel. */
export function rig() {
  const { left, right, delivered } = createProviderPair();
  const timers = manualTimers();
  const { issues, onIssue } = issueLog();
  const opener = createTransport(testSchema, left, {
    handshake: 'offer',
    hello: 'opener',
    timers,
    retryMs: RETRY_MS,
    timeoutMs: TIMEOUT_MS,
    onIssue,
  });
  const accepter = createTransport(testSchema, right, { handshake: 'respond', hello: 'accepter', onIssue });
  return { opener, accepter, timers, issues, delivered, left, right };
}

/**
 * `testSchema` with a `notes.read` and a `notes.watch` whose payloads count their decodes, so a test can tell which side
 * read a payload. The counted payloads are the request, the response, the start and the values.
 */
export function countedSchema() {
  let decodes = 0;
  const counted = <T>(codec: Codec<T>): Codec<T> =>
    enhanceCodec(
      codec,
      (value: T) => value,
      (value: T) => {
        decodes += 1;
        return value;
      },
    );
  const schema = defineSchema({
    version: VERSION,
    hello: str,
    sections: {
      notes: {
        ...notes,
        read: request({ request: counted(word), response: counted(str), error: str }),
        watch: subscription({ start: counted(word), receive: counted(word), interrupt: Result(_void, str) }),
      },
      echo,
    },
  });
  return { schema, decodes: () => decodes };
}

/**
 * A peer, a forwarder that serves it, the forwarder's upstream, and the server the upstream calls, over two in-memory
 * channels. The peer offers to the forwarder and the upstream to the server, and the forwarder forwards `notes.read`,
 * `notes.watch` and `echo.say` to the upstream before any call. `toForwarder` and `toUpstream` are what each channel
 * delivered, both ways.
 */
export function forwardRig(schema: typeof testSchema = testSchema) {
  const near = createProviderPair();
  const far = createProviderPair();
  const timers = manualTimers();
  const { issues, onIssue } = issueLog();
  const opening = { timers, retryMs: RETRY_MS, timeoutMs: TIMEOUT_MS, onIssue };
  const peer = createTransport(schema, near.left, { handshake: 'offer', hello: 'peer', ...opening });
  const forwarder = createTransport(schema, near.right, { handshake: 'respond', hello: 'forwarder', onIssue });
  const upstream = createTransport(schema, far.left, { handshake: 'offer', hello: 'upstream', ...opening });
  const server = createTransport(schema, far.right, { handshake: 'respond', hello: 'server', onIssue });
  const { read, watch } = schema.sections.notes;
  const stopForwarding = forwarder.forward([read, watch, schema.sections.echo.say], upstream);
  return {
    peer,
    forwarder,
    upstream,
    server,
    timers,
    issues,
    stopForwarding,
    toForwarder: near.delivered,
    toUpstream: far.delivered,
  };
}

/** How a test names a frame: its kind, or a call's tag and method, such as `request:notes.read`. */
const nameOf = (heard: RecordedFrame): string =>
  heard.kind === 'call' ? `${heard.decoded?.tag ?? 'unknown'}:${heard.section}.${heard.method}` : heard.kind;

/** The names of the frames a channel delivered, both ways, in order. */
export const namesOf = (delivered: readonly Uint8Array[]): string[] =>
  delivered.map(data => nameOf(readFrame(testSchema, data)));

/**
 * The message bytes of the calls a channel delivered under one name, such as `request:notes.read`, as hex, which
 * compares a large message at once.
 */
export const messageHex = (delivered: readonly Uint8Array[], name: string): string[] =>
  delivered.flatMap(data => {
    const heard = readFrame(testSchema, data);
    return heard.kind === 'call' && nameOf(heard) === name ? [toHex(heard.message)] : [];
  });

/** A peer the test speaks for, frame by frame, in place of a transport. */
function rawPeer(provider: Provider) {
  const heard: RecordedFrame[] = [];
  provider.subscribe(data => heard.push(readFrame(testSchema, data)));
  return {
    heard,
    /** Posts a message on a call `id` of `method`, at the place of `at`, which is `method` unless given. */
    call: <M>(
      method: AnyMethod & { readonly frame: Codec<Frame<M>> },
      id: number,
      message: M,
      at: AnyMethod = method,
    ) => {
      const address = testSchema.addressOf(at);
      const value = { sectionId: address.sectionId, methodId: address.methodId, message };
      provider.postMessage(method.frame.enc({ id, body: { tag: 'call', value } }));
    },
    /** Posts one of the library's own frames. */
    send: (id: number, body: Frame<Uint8Array>['body']) => {
      provider.postMessage(frame.enc({ id, body }));
    },
    /** Posts bytes that are no frame. */
    sendBytes: (...bytes: number[]) => {
      provider.postMessage(Uint8Array.from(bytes));
    },
    names: () => heard.map(nameOf),
    /** The handshake answers heard, by id. */
    handshakeResponses: () =>
      heard.flatMap(frame => (frame.kind === 'handshakeResponse' ? [{ id: frame.id, value: frame.value }] : [])),
    /** The failures heard, by id. */
    failures: () => heard.flatMap(frame => (frame.kind === 'failed' ? [{ id: frame.id, value: frame.value }] : [])),
    /** What the calls heard by one name carry, decoded with their method. */
    values: <M extends { value: V }, V>(method: { readonly message: Codec<M> }, name: string): V[] =>
      heard.flatMap(frame =>
        frame.kind === 'call' && nameOf(frame) === name ? [method.message.dec(frame.message).value] : [],
      ),
    /** The frames heard by one name. */
    find: (name: string) => heard.filter(frame => nameOf(frame) === name),
  };
}

/** A transport facing a raw peer, which answers nothing until the test says so. `wrap` stands between it and its side. */
export function rawRig(
  handshake: 'offer' | 'respond',
  wrap = (provider: Provider): Provider => provider,
  watched: WatchedSide = {},
) {
  const { left, right } = createProviderPair();
  const timers = manualTimers();
  const { issues, onIssue } = issueLog();
  const peer = rawPeer(right);
  const transport = createTransport(testSchema, wrap(left), {
    handshake,
    hello: handshake === 'offer' ? 'opener' : 'accepter',
    timers,
    retryMs: RETRY_MS,
    timeoutMs: TIMEOUT_MS,
    onIssue,
    ...watched,
  });
  /** Answers the first handshake the transport posted, as an accepter of the same version. */
  const answerHandshake = (): void => {
    const [attempt] = peer.find('handshakeOffer');
    if (attempt === undefined) {
      throw new Error('no handshake heard yet');
    }
    peer.send(attempt.id, { tag: 'handshakeResponse', value: ok(str.enc('peer')) });
  };
  /** Opens the handshake toward the transport, as an opener of schema `version` on wire version `wire`. */
  const openHandshake = (version = VERSION, id = 1, wire = WIRE_VERSION): void => {
    peer.send(id, { tag: 'handshakeOffer', value: { versions: { wire, schema: version }, hello: str.enc('peer') } });
  };
  return { transport, timers, issues, peer, left, right, answerHandshake, openHandshake };
}

/** A promise's outcome as a value: `{ value }` when it resolved, or the error it rejected with. */
export async function outcomeOf<T>(promise: Promise<T>): Promise<{ value: T } | Error> {
  return promise.then(
    value => ({ value }),
    (error: unknown) => toError(error),
  );
}

/** Wraps a provider so its posts throw `broken` while the test has it broken. */
export function breakable(broken: Error) {
  let posting = true;
  return {
    wrap: (provider: Provider): Provider => ({
      ...provider,
      postMessage: message => {
        if (!posting) {
          throw broken;
        }
        provider.postMessage(message);
      },
    }),
    breakPosts: () => {
      posting = false;
    },
    mendPosts: () => {
      posting = true;
    },
  };
}
