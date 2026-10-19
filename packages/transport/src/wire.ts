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
  createCodec,
  enhanceDecoder,
  u32,
  u8,
  type Codec,
  type CodecType,
  type Decoder,
  type ResultPayload,
} from 'scale-ts';
import { toError } from '@dotli/shared';
import { err, failure, ok, type TransportVersions } from './errors.js';
import type { Address } from './schema.js';

/** The version of the library's own wire: the frame, the failures and the handshake. The handshake checks it. */
export const WIRE_VERSION = 1;

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

// A frame variant that ends before the frame does refuses the bytes after it. Every other variant ends in bytes that
// take the rest of the frame, so it can leave none unread.
const ending = <T>(codec: Codec<T>): Codec<T> => createCodec(codec.enc, whole(codec));

// The wire version goes first, so a peer of any release reads it.
const versions: Codec<TransportVersions> = Struct({ wire: u8, schema: u8 });
// A hello stays bytes, since another release's may not decode.
const handshakeOffer = Struct({ versions, hello: Bytes(Infinity) });
const handshakeResponse = Result(Bytes(Infinity), ending(versions));

/** The opener's attempt: the versions it speaks and its hello. */
export type HandshakeOffer = CodecType<typeof handshakeOffer>;

/** The accepter's answer: its hello, or the versions it speaks. */
export type HandshakeResponse = CodecType<typeof handshakeResponse>;

const failed = ending(failure);

/** Frames whose calls carry `message`, with the ids of the call's method. */
export const frameOf = <M>(message: Codec<M>) =>
  Struct({
    id: u32,
    body: Enum({
      handshakeOffer,
      handshakeResponse,
      failed,
      call: Struct({ sectionId: u8, methodId: u8, message }),
    }),
  });

/** What crosses the wire, about the call or the handshake attempt `id` names. */
export type Frame<M> = CodecType<ReturnType<typeof frameOf<M>>>;

/** A message on a call, with the ids of its method. */
export type Call<M> = Extract<Frame<M>['body'], { tag: 'call' }>['value'];

/**
 * Frames as they arrive, and as the library writes its own, with a call's message as bytes. A frame decodes whole: a
 * call's message takes the rest of the frame, so its method refuses bytes after it.
 */
export const frame = frameOf(Bytes(Infinity));

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
