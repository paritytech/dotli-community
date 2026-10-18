// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Bytes, _void, u8, type Codec } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import { codec } from './codec.js';
import { cancelled, denied, domain, err, hostFailure, malformedFrame, ok, unsupported } from './result.js';
import { request, subscription, type RequestMessage, type SubscriptionMessage } from './schema.js';
import { decode, decodeAll, encodeFrame, frame, type Frame } from './wire.js';

const text = codec<string>(
  value => new TextEncoder().encode(value),
  bytes => new TextDecoder().decode(bytes),
);

const read = request({ request: text, response: text, error: u8 });
const touch = request({ request: _void, response: _void });
const watch = subscription({ start: text, receive: u8, interrupt: text });

const listed = (data: ArrayBuffer): number[] => [...new Uint8Array(data)];
const callOf = <M>(message: M): Frame<M>['body'] => ({ tag: 'call', value: { trait: 1, method: 2, message } });

/** Sends `message` on `method` through a frame, and reads it back as it arrives. */
function roundTrip<M>(method: { frame: Codec<Frame<M>>; message: Codec<M> }, message: M): M | null {
  const received = decodeAll(frame, encodeFrame(method.frame, { id: 0xffff_ffff, body: callOf(message) }));
  return received.body.tag === 'call' ? decodeAll(method.message, received.body.value.message) : null;
}

describe('wire', () => {
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
      { tag: 'interrupt', value: ok() },
      { tag: 'interrupt', value: err(domain('gone')) },
      { tag: 'stop', value: undefined },
    ];

    // When
    const decodedReads = reads.map(message => roundTrip(read, message));
    const decodedWatches = watches.map(message => roundTrip(watch, message));

    // Then
    expect(decodedReads).toEqual(reads);
    expect(decodedWatches).toEqual(watches);
  });

  it('As a peer of any release, I encode the handshake and a failure and get the frozen bytes', () => {
    // Given
    const frames: Frame<Uint8Array>[] = [
      { id: 1, body: { tag: 'open', value: { version: 3, hello: Uint8Array.of(0x68, 0x69) } } },
      { id: 2, body: { tag: 'accept', value: ok(Uint8Array.of(0x68, 0x69)) } },
      { id: 2, body: { tag: 'accept', value: err({ version: 3 }) } },
      { id: 0x0102_0304, body: { tag: 'failed', value: malformedFrame('no') } },
    ];

    // When
    const encoded = frames.map(value => listed(encodeFrame(frame, value)));

    // Then
    expect(encoded).toEqual([
      [1, 0, 0, 0, 0, 3, 0x68, 0x69],
      [2, 0, 0, 0, 1, 0, 0x68, 0x69],
      [2, 0, 0, 0, 1, 1, 3],
      [4, 3, 2, 1, 2, 3, 8, 0x6e, 0x6f],
    ]);
  });

  it("As a transport, I encode a call as its id, its method's ids and the method's own message", () => {
    // Given
    const message: RequestMessage<undefined, undefined, never> = { tag: 'request', value: undefined };

    // When
    const data = encodeFrame(touch.frame, { id: 5, body: callOf(message) });

    // Then
    expect(listed(data)).toEqual([5, 0, 0, 0, 3, 1, 2, 0]);
  });

  it('As a schema author, my decode gets exactly the payload bytes', () => {
    // Given
    const seen: number[][] = [];
    const recording = request({
      request: codec<string>(
        value => new TextEncoder().encode(value),
        payload => {
          seen.push([...payload]);
          return 'seen';
        },
      ),
      response: _void,
    });

    // When
    const message = decodeAll(recording.message, Uint8Array.of(0, 0x61, 0x62));

    // Then
    expect(message).toEqual({ tag: 'request', value: 'seen' });
    expect(seen).toEqual([[0x61, 0x62]]);
  });

  it('As a transport, I decode a message cut short and refuse it, though scale-ts reads it without a word', () => {
    // Given a request of four bytes that carries one
    const fixed = request({ request: Bytes(4), response: _void });
    const cut = Uint8Array.of(0, 0x61);

    // When
    const decoded = decode(fixed.message, cut);

    // Then
    expect(decoded).toEqual(err(new RangeError('The value runs 3 bytes past the end of the data')));
  });

  it('As a transport, I decode what a codec refuses and am told why', () => {
    // Given
    const messages = [
      // An outcome tag other than Ok or Err.
      Uint8Array.of(1, 2),
      // A CallError tag the wire does not define.
      Uint8Array.of(1, 1, 6),
      // A domain error on a method that declares none.
      Uint8Array.of(1, 1, 0),
      // A byte after a message that has ended.
      Uint8Array.of(0, 0xff),
    ];

    // When
    const decoded = messages.map(bytes => decode(touch.message, bytes));

    // Then
    expect(decoded).toEqual([
      err(expect.any(TypeError) as TypeError),
      err(expect.any(TypeError) as TypeError),
      err(new RangeError('the method declares no domain error')),
      err(new RangeError('1 bytes follow the end of the value')),
    ]);
  });
});
