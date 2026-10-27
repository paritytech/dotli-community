// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Result, _void, str, u8, type Codec, type ResultPayload } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import { callError, domain, type CallError } from './callError.js';
import { createWholeDecoder } from './createWholeDecoder.js';
import { cancelled, denied, hostFailure, malformedFrame, unsupported } from './failure.js';
import { frameCodec, type Frame } from './frame.js';
import type { MessageBytes } from './messageBytes.js';
import type { RequestMessage, SubscriptionMessage } from './method.js';
import { request } from './request.js';
import { err, ok } from './result.js';
import { subscription } from './subscription.js';

const read = request({ request: str, response: str, error: u8 });
const touch = request({ request: _void, response: _void });
const watch = subscription({ start: str, receive: u8, interrupt: str });
const listen = subscription({ start: str, receive: u8 });
const watchWithCallError = subscription({ start: str, receive: u8, interrupt: Result(_void, callError(str)) });

describe('frame', () => {
  it('As a transport, I encode every message of a method and decode it back with the method', () => {
    // Given
    const reads: RequestMessage<string, string, number>[] = [
      { tag: 'request', value: 'the first note' },
      { tag: 'response', value: ok('a body') },
      { tag: 'response', value: err(domain(7)) },
      { tag: 'response', value: err(denied()) },
      { tag: 'response', value: err(unsupported()) },
      { tag: 'response', value: err(malformedFrame('a short payload')) },
      { tag: 'response', value: err(hostFailure('TypeError: no such note')) },
      { tag: 'response', value: err(cancelled()) },
    ];
    const watches: SubscriptionMessage<string, number, string>[] = [
      { tag: 'start', value: 'from the top' },
      { tag: 'receive', value: 42 },
      { tag: 'interrupt', value: 'gone' },
      { tag: 'stop', value: undefined },
    ];

    // When
    const decodedReads = reads.map(message => sendRoundTrip(read, message));
    const decodedWatches = watches.map(message => sendRoundTrip(watch, message));

    // Then
    expect(decodedReads).toEqual(reads);
    expect(decodedWatches).toEqual(watches);
  });

  it('As a peer of any release, I encode the handshake and a failure and get the frozen bytes', () => {
    // Given
    const frames: Frame<MessageBytes>[] = [
      {
        id: 1,
        body: { tag: 'handshakeOffer', value: { versions: { wire: 1, schema: 3 }, hello: Uint8Array.of(0x68, 0x69) } },
      },
      { id: 2, body: { tag: 'handshakeResponse', value: ok(Uint8Array.of(0x68, 0x69)) } },
      { id: 2, body: { tag: 'handshakeResponse', value: err({ wire: 1, schema: 3 }) } },
      { id: 0x0102_0304, body: { tag: 'failed', value: malformedFrame('no') } },
    ];

    // When
    const encoded = frames.map(value => toList(frameCodec.enc(value)));

    // Then
    expect(encoded).toEqual([
      [1, 0, 0, 0, 0, 1, 3, 0x68, 0x69],
      [2, 0, 0, 0, 1, 0, 0x68, 0x69],
      [2, 0, 0, 0, 1, 1, 1, 3],
      [4, 3, 2, 1, 2, 2, 8, 0x6e, 0x6f],
    ]);
  });

  it("As a schema author, I send my interrupt and it crosses as my own type with nothing added, and in truapi's layout only when I choose it", () => {
    // Given
    const own: SubscriptionMessage<string, number, string> = { tag: 'interrupt', value: 'no' };
    const empty: SubscriptionMessage<string, number, undefined> = { tag: 'interrupt', value: undefined };
    const chosen: SubscriptionMessage<string, number, ResultPayload<undefined, CallError<string>>>[] = [
      { tag: 'interrupt', value: ok() },
      { tag: 'interrupt', value: err(domain('no')) },
      { tag: 'interrupt', value: err(hostFailure('no')) },
    ];

    // When
    const ownBytes = toList(watch.message.enc(own));
    const emptyBytes = toList(listen.message.enc(empty));
    const chosenBytes = chosen.map(message => toList(watchWithCallError.message.enc(message)));
    const roundTrips = [
      sendRoundTrip(watch, own),
      sendRoundTrip(listen, empty),
      chosen.map(message => sendRoundTrip(watchWithCallError, message)),
    ];

    // Then
    expect(ownBytes).toEqual([2, 8, 0x6e, 0x6f]);
    expect(emptyBytes).toEqual([2]);
    expect(chosenBytes).toEqual([
      [2, 0],
      [2, 1, 0, 8, 0x6e, 0x6f],
      [2, 1, 4, 8, 0x6e, 0x6f],
    ]);
    expect(roundTrips).toEqual([own, empty, chosen]);
  });

  it("As a transport, I encode a call and get its id, its method's ids and the method's own message", () => {
    // Given
    const message: RequestMessage<undefined, undefined, undefined> = { tag: 'request', value: undefined };

    // When
    const data = touch.frame.enc({ id: 5, body: createCallBody(message) });

    // Then
    expect(toList(data)).toEqual([5, 0, 0, 0, 3, 1, 2, 0]);
  });

  it('As a transport, I decode a value that leaves bytes unread and refuse it, as truapi decodes all', () => {
    // Given a message, a hello, a failure frame and a handshake refusal, each with a byte after it
    const message = Uint8Array.of(...read.message.enc({ tag: 'request', value: 'a' }), 0);
    const hello = Uint8Array.of(...str.enc('a'), 0);
    const failed = Uint8Array.of(...frameCodec.enc({ id: 1, body: { tag: 'failed', value: denied() } }), 0);
    const refusal: Frame<MessageBytes>['body'] = { tag: 'handshakeResponse', value: err({ wire: 1, schema: 3 }) };
    const refused = Uint8Array.of(...frameCodec.enc({ id: 2, body: refusal }), 0);

    // When
    const decoded = [
      readOrCatch(() => read.wholeMessage(message)),
      readOrCatch(() => createWholeDecoder(str)(hello)),
      readOrCatch(() => frameCodec.dec(failed)),
      readOrCatch(() => frameCodec.dec(refused)),
      readOrCatch(() => frameCodec.dec(failed.slice(0, -1))),
      readOrCatch(() => frameCodec.dec(refused.slice(0, -1))),
    ];

    // Then only the frames that end where their value ends decode, and the decoder throws on the rest
    const unread = new RangeError('The value is followed by unread bytes, 1 in all');
    expect(decoded).toEqual([
      unread,
      unread,
      unread,
      unread,
      { id: 1, body: { tag: 'failed', value: denied() } },
      { id: 2, body: refusal },
    ]);
  });
});

/** Runs `read`, and gives what it returns or what it throws. */
function readOrCatch(read: () => unknown): unknown {
  try {
    return read();
  } catch (error) {
    return error;
  }
}

function toList(data: Uint8Array): number[] {
  return [...data];
}

function createCallBody<Message>(message: Message): Frame<Message>['body'] {
  return { tag: 'call', value: { sectionId: 1, methodId: 2, message } };
}

/** Sends `message` on `method` through a frame, and reads it back as it arrives. */
function sendRoundTrip<Message>(
  method: { frame: Codec<Frame<Message>>; message: Codec<Message> },
  message: Message,
): Message | null {
  const received = frameCodec.dec(method.frame.enc({ id: 0xffff_ffff, body: createCallBody(message) }));
  return received.body.tag === 'call' ? method.message.dec(received.body.value.message) : null;
}
