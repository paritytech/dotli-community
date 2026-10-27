// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A method is a request or a subscription, built from the codecs of what its sides send, and carries its types, so the
// transport calls and serves it by the method itself.

import type { Codec, Decoder, ResultPayload } from 'scale-ts';
import type { CallError } from './callError.js';
import { createWholeDecoder } from './createWholeDecoder.js';
import { createFrameCodec } from './frame.js';

/** A record's entries as a tagged union, the shape a scale-ts `Enum` reads and writes. */
export type Variant<Entries> = { [Key in keyof Entries]: { tag: Key; value: Entries[Key] } }[keyof Entries];

/** What a request's sides send: its payload, then the answer. */
export type RequestTypes<Payload, Response, Domain> = {
  request: Payload;
  response: ResultPayload<Response, CallError<Domain>>;
};

/** What a subscription's sides send: its start, its values, then its end, or the caller's stop. */
export type SubscriptionTypes<Start, Value, Interrupt> = {
  start: Start;
  receive: Value;
  interrupt: Interrupt;
  stop: undefined;
};

/** A request's message, one of what its sides send. */
export type RequestMessage<Payload, Response, Domain> = Variant<RequestTypes<Payload, Response, Domain>>;

/** A subscription's message, one of what its sides send. */
export type SubscriptionMessage<Start, Value, Interrupt> = Variant<SubscriptionTypes<Start, Value, Interrupt>>;

/** A method: the codec of what its sides send, and of the frames that carry it. */
type Method<Message extends { tag: string }> = ReturnType<typeof createMethod<Message>>;

/** A request method. `Domain` is its own error, `undefined` when it declares none. */
export type Request<Payload, Response, Domain> = Method<RequestMessage<Payload, Response, Domain>>;

/** A subscription method. `Interrupt` is its own interrupt reason as a whole, `undefined` when it declares none. */
export type Subscription<Start, Value, Interrupt> = Method<SubscriptionMessage<Start, Value, Interrupt>>;

/** Any method, as a schema holds it. What its sides send is told apart by tag, whatever its payload types. */
export type AnyMethod = {
  /** Decodes a message of the method, enough to read its tag. */
  readonly message: { readonly dec: (data: Uint8Array) => { tag: string } };
  /** Reads only which leg a message is. Throws when the message's tag is no leg of the method. */
  readonly leg: (data: Uint8Array) => { tag: string };
};

/** What each side of a method sends, by name. */
export type MethodTypes<MethodType> =
  MethodType extends Request<infer Payload, infer Response, infer Domain>
    ? RequestTypes<Payload, Response, Domain>
    : MethodType extends Subscription<infer Start, infer Value, infer Interrupt>
      ? SubscriptionTypes<Start, Value, Interrupt>
      : never;

/** A method's own error: a request's `error`, or a subscription's `interrupt` reason as a whole. */
export type DomainError<MethodType> =
  MethodType extends Request<infer _Payload, infer _Response, infer Domain>
    ? Domain
    : MethodType extends Subscription<infer _Start, infer _Value, infer Interrupt>
      ? Interrupt
      : never;

/** A method of `message`, whose leg `leg` reads. */
export function createMethod<Message extends { tag: string }>(
  message: Codec<Message>,
  leg: Decoder<{ tag: Message['tag'] }>,
) {
  return {
    /** Encodes and decodes a message of the method. */
    message,
    /** Decodes a message, refusing one that leaves bytes unread. */
    wholeMessage: createWholeDecoder(message),
    /** Reads only which leg a message is, so a message whose payload does not decode still tells its leg. */
    leg,
    /** Encodes and decodes a frame that carries a message of the method. */
    frame: createFrameCodec(message),
  } as const;
}
