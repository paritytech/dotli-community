// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Result, _void, str, u8, type Codec, type ResultPayload } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import {
  callError,
  cancelled,
  denied,
  domain,
  err,
  hostFailure,
  malformedFrame,
  ok,
  unsupported,
  type CallError,
} from './errors.js';
import { codec, request, subscription, type RequestMessage, type SubscriptionMessage } from './schema.js';
import { decode, frame, type Frame } from './wire.js';

const read = request({ request: str, response: str, error: u8 });
const touch = request({ request: _void, response: _void });
const watch = subscription({ start: str, receive: u8, interrupt: str });
const listen = subscription({ start: str, receive: u8 });
const watchWithCallError = subscription({ start: str, receive: u8, interrupt: Result(_void, callError(str)) });

const listed = (data: Uint8Array): number[] => [...data];
const callOf = <M>(message: M): Frame<M>['body'] => ({ tag: 'call', value: { sectionId: 1, methodId: 2, message } });

/** Sends `message` on `method` through a frame, and reads it back as it arrives. */
function roundTrip<M>(method: { frame: Codec<Frame<M>>; message: Codec<M> }, message: M): M | null {
  const received = frame.dec(method.frame.enc({ id: 0xffff_ffff, body: callOf(message) }));
  return received.body.tag === 'call' ? method.message.dec(received.body.value.message) : null;
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
      { tag: 'interrupt', value: 'gone' },
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
      { id: 1, body: { tag: 'handshakeOffer', value: { version: 3, hello: Uint8Array.of(0x68, 0x69) } } },
      { id: 2, body: { tag: 'handshakeResponse', value: ok(Uint8Array.of(0x68, 0x69)) } },
      { id: 2, body: { tag: 'handshakeResponse', value: err({ version: 3 }) } },
      { id: 0x0102_0304, body: { tag: 'failed', value: malformedFrame('no') } },
    ];

    // When
    const encoded = frames.map(value => listed(frame.enc(value)));

    // Then
    expect(encoded).toEqual([
      [1, 0, 0, 0, 0, 3, 0x68, 0x69],
      [2, 0, 0, 0, 1, 0, 0x68, 0x69],
      [2, 0, 0, 0, 1, 1, 3],
      [4, 3, 2, 1, 2, 2, 8, 0x6e, 0x6f],
    ]);
  });

  it("As a schema author, my interrupt crosses as my own type with nothing added, and in truapi's layout only when I choose it", () => {
    // Given
    const own: SubscriptionMessage<string, number, string> = { tag: 'interrupt', value: 'no' };
    const empty: SubscriptionMessage<string, number, undefined> = { tag: 'interrupt', value: undefined };
    const chosen: SubscriptionMessage<string, number, ResultPayload<undefined, CallError<string>>>[] = [
      { tag: 'interrupt', value: ok() },
      { tag: 'interrupt', value: err(domain('no')) },
      { tag: 'interrupt', value: err(hostFailure('no')) },
    ];

    // When
    const ownBytes = listed(watch.message.enc(own));
    const emptyBytes = listed(listen.message.enc(empty));
    const chosenBytes = chosen.map(message => listed(watchWithCallError.message.enc(message)));

    // Then
    expect(ownBytes).toEqual([2, 8, 0x6e, 0x6f]);
    expect(emptyBytes).toEqual([2]);
    expect(chosenBytes).toEqual([
      [2, 0],
      [2, 1, 0, 8, 0x6e, 0x6f],
      [2, 1, 4, 8, 0x6e, 0x6f],
    ]);
    expect(roundTrip(watch, own)).toEqual(own);
    expect(roundTrip(listen, empty)).toEqual(empty);
    expect(chosen.map(message => roundTrip(watchWithCallError, message))).toEqual(chosen);
  });

  it("As a transport, I encode a call as its id, its method's ids and the method's own message", () => {
    // Given
    const message: RequestMessage<undefined, undefined, undefined> = { tag: 'request', value: undefined };

    // When
    const data = touch.frame.enc({ id: 5, body: callOf(message) });

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
    const message = recording.message.dec(Uint8Array.of(0, 0x61, 0x62));

    // Then
    expect(message).toEqual({ tag: 'request', value: 'seen' });
    expect(seen).toEqual([[0x61, 0x62]]);
  });

  it('As a transport, I decode what a codec refuses and am told why', () => {
    // Given
    const messages = [
      // An outcome tag other than Ok or Err.
      Uint8Array.of(1, 2),
      // A CallError tag the wire does not define.
      Uint8Array.of(1, 1, 6),
    ];

    // When
    const decoded = messages.map(bytes => decode(touch.message, bytes));

    // Then
    expect(decoded).toEqual([err(expect.any(Error) as Error), err(expect.any(Error) as Error)]);
  });
});
