// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A transport facing a peer that sends raw bytes, for tests of how it reads what it cannot trust.

import { createManualTimers } from '@dotli/shared/testing';
import { str, type Codec } from 'scale-ts';
import { WIRE_VERSION } from '../constants.js';
import { createTransport } from '../createTransport.js';
import type { TransportIssue } from '../describeIssue.js';
import { frameCodec, type Frame } from '../frame.js';
import type { MessageBytes } from '../messageBytes.js';
import type { AnyMethod } from '../method.js';
import { createProviderPair } from '../provider.fake.js';
import type { Provider } from '../provider.js';
import { ok } from '../result.js';
import { RETRY_MS, TIMEOUT_MS, VERSION } from './constants.js';
import { createIssueLog } from './createIssueLog.js';
import { getFrameName } from './getFrameName.js';
import { readFrame, type RecordedFrame } from './readFrame.js';
import { testSchema } from './testSchema.js';

/** What a test sets on the transport a raw rig builds. */
export type RawRigParams = {
  /** Whether the transport offers the handshake or responds to the raw peer's offer. */
  handshake: 'offer' | 'respond';
  /** Stands between the transport and its side of the channel. */
  wrap?: (provider: Provider) => Provider;
  /** Replaces the issue log, which then stays empty. */
  onIssue?: (issue: TransportIssue) => void;
  /** Replaces the rig's handshake deadline. `null` waits for an answer with no deadline. */
  timeoutMs?: number | null;
};

/** How a raw peer opens the handshake toward the transport. */
type HandshakeParams = {
  /** The schema version the raw peer offers. */
  version?: number;
  /** The id of the offer. */
  id?: number;
  /** The wire version the raw peer offers. */
  wire?: number;
};

/** How a raw peer posts a message on a call. */
type CallParams<Message> = {
  /** The method whose codec encodes the frame. */
  method: AnyMethod & { readonly frame: Codec<Frame<Message>> };
  /** The id of the call. */
  id: number;
  /** The message the frame carries. */
  message: Message;
  /** The method whose place the frame names, `method` unless given. */
  at?: AnyMethod;
};

/** A transport facing a raw peer, which answers nothing until the test says so. */
export function createRawRig({ handshake, wrap = provider => provider, ...overrides }: RawRigParams) {
  const { left, right } = createProviderPair();
  const timers = createManualTimers();
  const { issues, onIssue } = createIssueLog();
  const peer = createRawPeer(right);
  const transport = createTransport({
    schema: testSchema,
    provider: wrap(left),
    handshake,
    hello: handshake === 'offer' ? 'opener' : 'accepter',
    timers,
    retryMs: RETRY_MS,
    timeoutMs: TIMEOUT_MS,
    onIssue,
    ...overrides,
  });
  return { transport, timers, issues, peer, left, right, answerHandshake, openHandshake };

  /** Answers the first handshake the transport posted, as an accepter of the same version. */
  function answerHandshake(): void {
    const [attempt] = peer.find('handshakeOffer');
    if (attempt === undefined) {
      throw new Error('no handshake heard yet');
    }
    peer.send(attempt.id, { tag: 'handshakeResponse', value: ok(str.enc('peer')) });
  }

  /** Opens the handshake toward the transport, as an opener of schema `version` on wire version `wire`. */
  function openHandshake({ version = VERSION, id = 1, wire = WIRE_VERSION }: HandshakeParams = {}): void {
    peer.send(id, { tag: 'handshakeOffer', value: { versions: { wire, schema: version }, hello: str.enc('peer') } });
  }
}

/** A peer the test speaks for, frame by frame, in place of a transport. */
function createRawPeer(provider: Provider) {
  const heard: RecordedFrame[] = [];
  provider.subscribe(data => heard.push(readFrame(testSchema, data)));
  return {
    heard,
    /** Posts a message on a call. */
    call: <Message>({ method, id, message, at = method }: CallParams<Message>) => {
      const address = testSchema.addressOf(at);
      const value = { sectionId: address.sectionId, methodId: address.methodId, message };
      provider.postMessage(method.frame.enc({ id, body: { tag: 'call', value } }));
    },
    /** Posts one of the library's own frames. */
    send: (id: number, body: Frame<MessageBytes>['body']) => {
      provider.postMessage(frameCodec.enc({ id, body }));
    },
    /** Posts bytes that are no frame. */
    sendBytes: (...bytes: number[]) => {
      provider.postMessage(Uint8Array.from(bytes));
    },
    /** The names of the frames heard, in order. */
    getNames: () => heard.map(getFrameName),
    /** The handshake answers heard, by id. */
    getHandshakeResponses: () =>
      heard.flatMap(frame => (frame.kind === 'handshakeResponse' ? [{ id: frame.id, value: frame.value }] : [])),
    /** The failures heard, by id. */
    getFailures: () => heard.flatMap(frame => (frame.kind === 'failed' ? [{ id: frame.id, value: frame.value }] : [])),
    /** What the calls heard by one name carry, decoded with their method. */
    getValues: <Message extends { value: Value }, Value>(
      method: { readonly message: Codec<Message> },
      name: string,
    ): Value[] =>
      heard.flatMap(frame =>
        frame.kind === 'call' && getFrameName(frame) === name ? [method.message.dec(frame.message).value] : [],
      ),
    /** The frames heard by one name. */
    find: (name: string) => heard.filter(frame => getFrameName(frame) === name),
  };
}
