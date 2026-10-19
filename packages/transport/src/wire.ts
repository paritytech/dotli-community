// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A frame is a call id and one enum: the handshake's offer and response, a failure the library answers a call with, or a
// call's message on a method. A message is its method's own enum, so a frame encodes in one pass of a codec composed
// from the method's. A received frame keeps the message as bytes until the method it names decodes it. The id, the
// handshake variants and the wire version that opens an offer never change, so a peer of any release reads the versions
// it refuses.

import {
  Bytes,
  Enum,
  Result,
  Struct,
  Tuple,
  enhanceDecoder,
  u32,
  u8,
  type Codec,
  type CodecType,
  type Decoder,
  type ResultPayload,
} from 'scale-ts';
import { toError } from '@dotli/shared';
import { err, failure, ok } from './errors.js';
import type { Address } from './schema.js';

/** The version of the library's own wire: the frame, the failures and the handshake. The handshake checks it. */
export const WIRE_VERSION = 1;

// A hello stays bytes, since another release's may not decode.
const handshakeOffer = Struct({ wireVersion: u8, version: u8, hello: Bytes(Infinity) });
const handshakeResponse = Result(Bytes(Infinity), Struct({ wireVersion: u8, version: u8 }));

/** The opener's attempt: its wire version, its schema's version and its hello. */
export type HandshakeOffer = CodecType<typeof handshakeOffer>;

/** The accepter's answer: its hello, or the wire and schema versions it speaks. */
export type HandshakeResponse = CodecType<typeof handshakeResponse>;

/** Frames whose calls carry `message`, with the ids of the call's method. */
export const frameOf = <M>(message: Codec<M>) =>
  Struct({
    id: u32,
    body: Enum({
      handshakeOffer,
      handshakeResponse,
      failed: failure,
      call: Struct({ sectionId: u8, methodId: u8, message }),
    }),
  });

/** What crosses the wire, about the call or the handshake attempt `id` names. */
export type Frame<M> = CodecType<ReturnType<typeof frameOf<M>>>;

/** A message on a call, with the ids of its method. */
export type Call<M> = Extract<Frame<M>['body'], { tag: 'call' }>['value'];

/** Frames as they arrive, and as the library writes its own, with a call's message as bytes. */
export const frame = frameOf(Bytes(Infinity));

/**
 * The decoder of `codec` that refuses a value which leaves bytes unread, as truapi's `decode_all` does. Built once per
 * codec, since composing it per message would cost each message the composition.
 */
export const whole = <T>(codec: Codec<T>): Decoder<T> =>
  enhanceDecoder(Tuple.dec(codec.dec, Bytes.dec(Infinity)), ([value, rest]) => {
    if (rest.length > 0) {
      throw new RangeError(`The value is followed by unread bytes, ${String(rest.length)} in all`);
    }
    return value;
  });

/** Reads a whole frame. A call's message takes the rest of the frame, so its method refuses bytes after it. */
export const wholeFrame = whole(frame);

/** Decodes `data`, or says why it does not. */
export function decode<T>(decoder: (data: Uint8Array) => T, data: Uint8Array): ResultPayload<T, Error> {
  try {
    return ok(decoder(data));
  } catch (error) {
    return err(toError(error));
  }
}

/** Encodes a message on call `id` of the method at `address`, or says why it cannot. */
export function encodeCall<M>(
  method: { readonly frame: Codec<Frame<M>> },
  address: Address,
  id: number,
  message: M,
): ResultPayload<Uint8Array, Error> {
  try {
    const call = { sectionId: address.sectionId, methodId: address.methodId, message };
    return ok(method.frame.enc({ id, body: { tag: 'call', value: call } }));
  } catch (error) {
    return err(toError(error));
  }
}
