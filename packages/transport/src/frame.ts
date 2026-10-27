// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A frame is a call id and one enum: the handshake's offer and response, a failure the library answers a call with, or
// a call's message on a method. A message is its method's own enum, so a frame encodes in one pass of a codec composed
// from the method's. A received frame keeps the message as bytes until the method it names decodes it. The id and the
// handshake variants never change, so a peer of any release reads the versions it refuses.

import { Enum, Struct, u32, u8, type Codec, type CodecType } from 'scale-ts';
import { codec } from './codec.js';
import type { Address } from './defineSchema.js';
import { createEndingCodec } from './createEndingCodec.js';
import { failureCodec } from './failure.js';
import { toFrameBytes, type FrameBytes } from './frameBytes.js';
import { handshakeOfferCodec, handshakeResponseCodec } from './handshakeCodecs.js';
import { toMessageBytes, type MessageBytes } from './messageBytes.js';

/** What crosses the wire, about the call or the handshake attempt `id` names. */
export type Frame<Message> = CodecType<ReturnType<typeof createFrameCodec<Message>>>;

/** A message on a call, with the ids of its method. */
export type Call<Message> = Extract<Frame<Message>['body'], { tag: 'call' }>['value'];

type EncodeCallParams<Message> = {
  method: { readonly frame: Codec<Frame<Message>> };
  address: Address;
  id: number;
  message: Message;
};

type EncodeCarriedCallParams = {
  address: Address;
  id: number;
  message: MessageBytes;
};

const failedCodec = createEndingCodec(failureCodec);

/**
 * Frames as they arrive, and as the library writes its own, with a call's message as bytes. A frame decodes whole: a
 * call's message takes the rest of the frame, so its method refuses bytes after it.
 */
export const frameCodec = createFrameCodec(codec<MessageBytes>(bytes => bytes, toMessageBytes));

/** Frames whose calls carry `message`, with the ids of the call's method. */
export function createFrameCodec<Message>(message: Codec<Message>) {
  return Struct({
    id: u32,
    body: Enum({
      handshakeOffer: handshakeOfferCodec,
      handshakeResponse: handshakeResponseCodec,
      failed: failedCodec,
      call: Struct({ sectionId: u8, methodId: u8, message }),
    }),
  });
}

/**
 * Encodes `message` on call `id` of the method at `address`. Throws the codec's error when the wire cannot carry it.
 */
export function encodeCall<Message>({ method, address, id, message }: EncodeCallParams<Message>): FrameBytes {
  const call = { sectionId: address.sectionId, methodId: address.methodId, message };
  return toFrameBytes(method.frame.enc({ id, body: { tag: 'call', value: call } }));
}

/** A frame that carries `message` on call `id` of the method at `address`, as the bytes it is. */
export function encodeCarriedCall({ address, id, message }: EncodeCarriedCallParams): FrameBytes {
  return encodeFrame({
    id,
    body: { tag: 'call', value: { sectionId: address.sectionId, methodId: address.methodId, message } },
  });
}

/**
 * Encodes one of the library's own frames, or a call whose message is already bytes. Throws the codec's error when the
 * frame cannot be encoded.
 */
export function encodeFrame(frame: Frame<MessageBytes>): FrameBytes {
  return toFrameBytes(frameCodec.enc(frame));
}
