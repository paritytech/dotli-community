// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A frame is a call id and one enum: the handshake's open and accept, a failure the library answers a call with, or a
// call's message on a method. A message is its method's own enum, so a frame encodes in one pass of a codec composed
// from the method's. A received frame keeps the message as bytes until the method it names decodes it. The id and the
// handshake variants never change, so a peer of any release reads the version it refuses.

import { Bytes, Enum, Result, Struct, u32, u8, type Codec, type CodecType, type ResultPayload } from 'scale-ts';
import { toError } from '@dotli/shared';
import { err, failure, ok } from './errors.js';
import type { Address } from './schema.js';

// A hello stays bytes, since another release's may not decode.
const open = Struct({ version: u8, hello: Bytes(Infinity) });
const accept = Result(Bytes(Infinity), Struct({ version: u8 }));

/** The opener's attempt: its version and its hello. */
export type Open = CodecType<typeof open>;

/** The accepter's answer: its hello, or the version it speaks. */
export type Accept = CodecType<typeof accept>;

/** Frames whose calls carry `message`, with the ids of the call's method. */
export const frameOf = <M>(message: Codec<M>) =>
  Struct({
    id: u32,
    body: Enum({ open, accept, failed: failure, call: Struct({ sectionId: u8, methodId: u8, message }) }),
  });

/** What crosses the wire, about the call or the handshake attempt `id` names. */
export type Frame<M> = CodecType<ReturnType<typeof frameOf<M>>>;

/** A message on a call, with the ids of its method. */
export type Call<M> = Extract<Frame<M>['body'], { tag: 'call' }>['value'];

/** Frames as they arrive, and as the library writes its own, with a call's message as bytes. */
export const frame = frameOf(Bytes(Infinity));

/** Decodes `data`, or says why it does not. */
export function decode<T>(codec: Codec<T>, data: Uint8Array): ResultPayload<T, Error> {
  try {
    return ok(codec.dec(data));
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
