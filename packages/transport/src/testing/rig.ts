// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A test schema and two transports over one in-memory channel, or one transport facing a raw peer the test speaks for.

import { manualTimers } from '@dotli/shared/testing';
import { codec, none } from '../codec.js';
import type { TransportIssue } from '../errors.js';
import { createProviderPair } from '../provider.fake.js';
import type { Provider } from '../provider.js';
import { defineSchema, request, subscription } from '../schema.js';
import type { CallError, Result } from '../result.js';
import type { Sink } from '../serving.js';
import { createTransport, type Transport } from '../transport.js';
import { encodeMessage, type WireMessage } from '../wire.js';
import { describeMessage, type DescribedMessage } from './index.js';

export const RETRY_MS = 50;
export const TIMEOUT_MS = 5_000;
export const VERSION = 3;

const encoder = new TextEncoder();
// Fatal, so bytes that are no UTF-8 fail to decode as a peer's payload can.
const decoder = new TextDecoder('utf-8', { fatal: true });

const text = codec<string>(
  value => encoder.encode(value),
  bytes => decoder.decode(bytes),
);

/** Text that is never empty, so a test can make a payload that does not encode. */
const word = codec<string>(
  value => {
    if (value === '') {
      throw new RangeError('A word is never empty');
    }
    return encoder.encode(value);
  },
  bytes => decoder.decode(bytes),
);

export const testSchema = defineSchema({
  version: VERSION,
  hello: text,
  traits: {
    notes: {
      read: request({ request: word, response: text, error: text }),
      touch: request({ request: none, response: none }),
      watch: subscription({ start: word, receive: word, interrupt: text }),
    },
    echo: {
      say: request({ request: text, response: text }),
      listen: subscription({ start: none, receive: text }),
    },
  },
});

// Wire ids are positions in the schema above.
export const NOTES = 0;
export const READ = 0;
export const TOUCH = 1;
export const WATCH = 2;
export const ECHO = 1;
export const LISTEN = 1;

export type TestSchema = typeof testSchema;

/** Listeners of a `notes.watch` subscription that record the values and the ends it hears. */
export function watcher() {
  const values: string[] = [];
  const ends: Result<void, CallError<string>>[] = [];
  return {
    values,
    ends,
    receive: (value: string) => {
      values.push(value);
    },
    interrupt: (outcome: Result<void, CallError<string>>) => {
      ends.push(outcome);
    },
  };
}

/** Serves `notes.watch` on a transport, keeping each subscription's start and sink and counting its stops. */
export function serveWatch(transport: Transport<TestSchema>) {
  const starts: string[] = [];
  const sinks: Sink<string, string>[] = [];
  const stops: number[] = [];
  transport.handleSubscription('notes', 'watch', (start, _context, sink) => {
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

/** How a test names a message: its leg and address, such as `request:notes.read`. */
const legOf = (message: DescribedMessage): string => `${message.leg}:${message.trait}.${message.method}`;

/** A peer the test speaks for, message by message, in place of a transport. */
function rawPeer(provider: Provider) {
  const heard: DescribedMessage[] = [];
  provider.subscribe(data => heard.push(describeMessage(testSchema, data)));
  return {
    heard,
    send: (message: WireMessage) => {
      provider.post(encodeMessage(testSchema, message));
    },
    /** Posts bytes the test wrote by hand. */
    sendBytes: (...bytes: number[]) => {
      provider.post(Uint8Array.from(bytes).buffer);
    },
    legs: () => heard.map(legOf),
    /** The messages heard on one leg and address. */
    find: (leg: string) => heard.filter(message => legOf(message) === leg),
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
    const [attempt] = peer.find('request:255.0');
    if (attempt === undefined) {
      throw new Error('no handshake heard yet');
    }
    peer.send({ kind: 'handshake', leg: 'response', id: attempt.id, outcome: { ok: true, value: 'peer' } });
  };
  /** Opens the handshake toward the transport, as an opener of `version`. */
  const openHandshake = (version = VERSION, id = 1): void => {
    peer.send({ kind: 'handshake', leg: 'request', id, version, hello: 'peer' });
  };
  return { transport, timers, issues, peer, left, right, answerHandshake, openHandshake };
}

/** A promise's outcome as a value: `{ value }` when it resolved, or the very error it rejected with. */
export async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    value => ({ value }),
    (error: unknown) => error,
  );
}

/** Wraps a provider so its posts throw `broken` while the test has it broken. */
export function breakable(broken: Error) {
  let posting = true;
  return {
    wrap: (provider: Provider): Provider => ({
      ...provider,
      post: data => {
        if (!posting) {
          throw broken;
        }
        provider.post(data);
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
