// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A frame is a request id and one enum: the handshake's open and accept, a failure the library answers a call with, or a
// call's message on a method. A message is its method's own enum, so a frame encodes in one pass of a codec composed
// from the method's. A received frame keeps the message as bytes until the method it names decodes it. The id and the
// handshake variants never change, so a peer of any release reads the version it refuses.

import { Bytes, Enum, Struct, _void, createCodec, createDecoder, str, u32, u8, type Codec } from 'scale-ts';
import { toError } from '@dotli/shared';
import { err, ok, type CallError, type Result, type Variant } from './result.js';

/** truapi's `Result`. */
export const outcome = <T, E>(value: Codec<T>, error: Codec<E>): Codec<Result<T, E>> => Enum({ Ok: value, Err: error });

const reason = Struct({ reason: str });

/** truapi's `CallError`, with its variants at their indices. */
export const callError = <E>(domain: Codec<E>): Codec<CallError<E>> =>
  Enum({
    Domain: domain,
    Denied: _void,
    Unsupported: _void,
    MalformedFrame: reason,
    HostFailure: reason,
    Cancelled: _void,
  });

/** The domain error of a method that declares none. No value has it, so it never encodes and never decodes. */
export const noDomainError: Codec<never> = createCodec<never>(
  () => new Uint8Array(0),
  createDecoder(() => {
    throw new RangeError('the method declares no domain error');
  }),
);

/** The opener's attempt: its version and its hello. */
export interface Open {
  version: number;
  hello: Uint8Array;
}

/** The accepter's answer: its hello, or the version it speaks. */
export type Accept = Result<Uint8Array, { version: number }>;

/** A message on a call, with the ids of its method. */
export interface Call<M> {
  trait: number;
  method: number;
  message: M;
}

/** What crosses the wire, about the call or the handshake attempt `id` names. */
export interface Frame<M> {
  id: number;
  body: Variant<{ open: Open; accept: Accept; failed: CallError<never>; call: Call<M> }>;
}

/** Frames whose calls carry `message`. A hello stays bytes, since another release's may not decode. */
export const frameOf = <M>(message: Codec<M>): Codec<Frame<M>> =>
  Struct({
    id: u32,
    body: Enum({
      open: Struct({ version: u8, hello: Bytes(Infinity) }),
      accept: outcome(Bytes(Infinity), Struct({ version: u8 })),
      failed: callError(noDomainError),
      call: Struct({ trait: u8, method: u8, message }),
    }),
  });

/** Frames as they arrive, and as the library writes its own, with a call's message as bytes. */
export const frame = frameOf(Bytes(Infinity));

/** Where a scale-ts decoder stopped. scale-ts reads on a byte array that carries its position as `i`. */
function positionOf(bytes: Uint8Array): number {
  if ('i' in bytes && typeof bytes.i === 'number') {
    return bytes.i;
  }
  throw new TypeError('The decoder was given no position');
}

/**
 * Decodes all of `data`, refusing a value that ends before the data does or runs past it, since scale-ts reads a value
 * cut short without a word.
 */
export function decodeAll<T>(codec: Codec<T>, data: Uint8Array | ArrayBuffer): T {
  return createDecoder(input => {
    const value = codec.dec(input);
    const left = input.length - positionOf(input);
    if (left > 0) {
      throw new RangeError(`${String(left)} bytes follow the end of the value`);
    }
    if (left < 0) {
      throw new RangeError(`The value runs ${String(-left)} bytes past the end of the data`);
    }
    return value;
  })(data);
}

/** Decodes all of `data`, or says why it does not. */
export function decode<T>(codec: Codec<T>, data: Uint8Array | ArrayBuffer): Result<T, Error> {
  try {
    return ok(decodeAll(codec, data));
  } catch (error) {
    return err(toError(error));
  }
}

/** Encodes a frame into a buffer of its own, which a provider can transfer. */
export const encodeFrame = <M>(codec: Codec<Frame<M>>, value: Frame<M>): ArrayBuffer => codec.enc(value).slice().buffer;

/** Encodes a frame, or says why it cannot. */
export function encode<M>(codec: Codec<Frame<M>>, value: Frame<M>): Result<ArrayBuffer, Error> {
  try {
    return ok(encodeFrame(codec, value));
  } catch (error) {
    return err(toError(error));
  }
}
