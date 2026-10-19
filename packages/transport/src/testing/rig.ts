// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A test schema and two transports over one in-memory channel, or one transport facing a raw peer the test speaks for.

import { toError } from '@dotli/shared';
import { manualTimers } from '@dotli/shared/testing';
import { Bytes, _void, enhanceCodec, str, type Codec, type ResultPayload } from 'scale-ts';
import { ok, type CallError, type TransportIssue } from '../errors.js';
import { createProviderPair } from '../provider.fake.js';
import type { Provider } from '../provider.js';
import { defineSchema, request, subscription, type AnyMethod } from '../schema.js';
import { createTransport, type Sink, type Transport } from '../transport.js';
import { frame, type Frame } from '../wire.js';
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
      watch: subscription({ start: word, receive: word, interrupt: str }),
    },
    echo: {
      say: request({ request: str, response: str }),
      listen: subscription({ start: _void, receive: str }),
    },
  },
});

export const { notes, echo } = testSchema.sections;

/** The wire id of the `notes` section, for a test that calls a method the section lacks. */
export const NOTES = testSchema.addressOf(notes.read).sectionId;

// `notes.read` and `notes.watch` with every payload as bytes, so a test can send what their codecs refuse.
const bytes = Bytes(Infinity);
export const rawRead = request({ request: bytes, response: bytes, error: bytes });
export const rawWatch = subscription({ start: bytes, receive: bytes, interrupt: bytes });

/** Text cut short: its length says two bytes and none follow, so `str` refuses it. */
export const CUT_SHORT_TEXT = Uint8Array.of(8);

/** Listeners of a `notes.watch` subscription that record the values it hears, its interrupts and its closes. */
export function watcher() {
  const values: string[] = [];
  const ends: ResultPayload<undefined, CallError<string>>[] = [];
  const closes: Error[] = [];
  return {
    values,
    ends,
    closes,
    receive: (value: string) => {
      values.push(value);
    },
    interrupt: (outcome: ResultPayload<undefined, CallError<string>>) => {
      ends.push(outcome);
    },
    close: (error: Error) => {
      closes.push(error);
    },
  };
}

/** Serves `notes.watch` on a transport, keeping each subscription's start and sink and counting its stops. */
export function serveWatch(transport: Transport<string>) {
  const starts: string[] = [];
  const sinks: Sink<string, string>[] = [];
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

/** What a test may set on the side it watches: the accepter of `rig`, or the transport of `rawRig`. */
interface WatchedSide {
  onPeerIdle?: () => void;
  /** Replaces the issue log, which then stays empty. */
  onIssue?: (issue: TransportIssue) => void;
}

/** An opener on the left and an accepter on the right, over one in-memory channel. */
export function rig(watched: WatchedSide = {}) {
  const { left, right, delivered } = createProviderPair();
  const timers = manualTimers();
  const { issues, onIssue } = issueLog();
  const opener = createTransport(testSchema, left, {
    handshake: 'open',
    hello: 'opener',
    timers,
    retryMs: RETRY_MS,
    timeoutMs: TIMEOUT_MS,
    onIssue,
  });
  const accepter = createTransport(testSchema, right, { handshake: 'accept', hello: 'accepter', onIssue, ...watched });
  return { opener, accepter, timers, issues, delivered, left, right };
}

/** How a test names a frame: its kind, or a call's tag and method, such as `request:notes.read`. */
const nameOf = (heard: RecordedFrame): string =>
  heard.kind === 'call' ? `${heard.decoded?.tag ?? 'unknown'}:${heard.section}.${heard.method}` : heard.kind;

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
    accepts: () => heard.flatMap(frame => (frame.kind === 'accept' ? [{ id: frame.id, value: frame.value }] : [])),
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
  handshake: 'open' | 'accept',
  wrap = (provider: Provider): Provider => provider,
  watched: WatchedSide = {},
) {
  const { left, right } = createProviderPair();
  const timers = manualTimers();
  const { issues, onIssue } = issueLog();
  const peer = rawPeer(right);
  const transport = createTransport(testSchema, wrap(left), {
    handshake,
    hello: handshake === 'open' ? 'opener' : 'accepter',
    timers,
    retryMs: RETRY_MS,
    timeoutMs: TIMEOUT_MS,
    onIssue,
    ...watched,
  });
  /** Answers the first handshake the transport posted, as an accepter of the same version. */
  const answerHandshake = (): void => {
    const [attempt] = peer.find('open');
    if (attempt === undefined) {
      throw new Error('no handshake heard yet');
    }
    peer.send(attempt.id, { tag: 'accept', value: ok(str.enc('peer')) });
  };
  /** Opens the handshake toward the transport, as an opener of `version`. */
  const openHandshake = (version = VERSION, id = 1): void => {
    peer.send(id, { tag: 'open', value: { version, hello: str.enc('peer') } });
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
