// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A schema nests sections, then methods. A method is a request or a subscription, built from the codecs of what its sides
// send, and carries its types, so the transport calls and serves it by the method itself. Wire ids are positions.

import { Bytes, Enum, Result, _void, enhanceCodec, type Codec, type Decoder, type ResultPayload } from 'scale-ts';
import { callError, type CallError } from './errors.js';
import { frameOf, whole, type Frame } from './wire.js';

/** Wraps plain encode and decode functions as a codec. A payload ends its message, so it takes the rest of the bytes. */
export function codec<T>(encode: (value: T) => Uint8Array, decode: (bytes: Uint8Array) => T): Codec<T> {
  return enhanceCodec(Bytes(Infinity), encode, decode);
}

/** A record's entries as a tagged union, the shape a scale-ts `Enum` reads and writes. */
export type Variant<T> = { [K in keyof T]: { tag: K; value: T[K] } }[keyof T];

/** What a request's sides send: its payload, then the answer. */
export type RequestTypes<P, R, E> = {
  request: P;
  response: ResultPayload<R, CallError<E>>;
};

/** What a subscription's sides send: its start, its values, then its end, or the caller's stop. */
export type SubscriptionTypes<S, V, I> = {
  start: S;
  receive: V;
  interrupt: I;
  stop: undefined;
};

/** A request's message, one of what its sides send. */
export type RequestMessage<P, R, E> = Variant<RequestTypes<P, R, E>>;

/** A subscription's message, one of what its sides send. */
export type SubscriptionMessage<S, V, I> = Variant<SubscriptionTypes<S, V, I>>;

/** A method: the codec of what its sides send, and of the frames that carry it. */
type Method<M extends { tag: string }> = {
  readonly message: Codec<M>;
  /** Decodes a message, refusing one that leaves bytes unread. */
  readonly wholeMessage: Decoder<M>;
  /** Reads only which leg a message is, so a message whose payload does not decode still tells its leg. */
  readonly leg: Decoder<{ tag: M['tag'] }>;
  readonly frame: Codec<Frame<M>>;
};

/** A request method. `E` is its own error, `undefined` when it declares none. */
export type Request<P, R, E> = Method<RequestMessage<P, R, E>>;

/** A subscription method. `I` is its own interrupt reason as a whole, `undefined` when it declares none. */
export type Subscription<S, V, I> = Method<SubscriptionMessage<S, V, I>>;

const method = <M extends { tag: string }>(message: Codec<M>, leg: Decoder<{ tag: M['tag'] }>): Method<M> => ({
  message,
  wholeMessage: whole(message),
  leg,
  frame: frameOf(message),
});

// The legs of each kind of method in wire order, so a method's message and the reader of its leg share one layout.
const requestLegs = <P, A>(request: Codec<P>, response: Codec<A>) => Enum({ request, response });
const subscriptionLegs = <S, V, I>(start: Codec<S>, receive: Codec<V>, interrupt: Codec<I>) =>
  Enum({ start, receive, interrupt, stop: _void });

// A leg's payload is read as nothing, so reading a message's leg reads only its tag and copies no payload.
const requestLeg = requestLegs(_void, _void).dec;
const voidSubscriptionLegs = subscriptionLegs(_void, _void, _void);
const subscriptionLeg = voidSubscriptionLegs.dec;

/** The stop of any subscription, which carries nothing, so a side that decodes none of its messages can send it. */
export const SUBSCRIPTION_STOP = voidSubscriptionLegs.enc({ tag: 'stop', value: undefined });

/** Reads a subscription message's leg and refuses bytes left unread, so a stop is checked with no payload codec. */
export const wholeSubscriptionLeg = whole(voidSubscriptionLegs);

/** Declares a request. `error` is the method's own error, and a method without one has an empty one. */
export function request<P, R>(def: { request: Codec<P>; response: Codec<R> }): Request<P, R, undefined>;
export function request<P, R, E>(def: { request: Codec<P>; response: Codec<R>; error: Codec<E> }): Request<P, R, E>;
export function request<P, R, E>(def: {
  request: Codec<P>;
  response: Codec<R>;
  error?: Codec<E>;
}): Request<P, R, E> | Request<P, R, undefined> {
  const requestOf = <D>(error: Codec<D>): Request<P, R, D> =>
    method(requestLegs(def.request, Result(def.response, callError(error))), requestLeg);
  return def.error === undefined ? requestOf(_void) : requestOf(def.error);
}

/**
 * Declares a subscription. `interrupt` is the method's own interrupt reason, which crosses as it is with nothing added,
 * and one without it has an empty one. A schema that wants truapi's layout declares `Result(_void, callError(reason))`.
 */
export function subscription<S, V>(def: { start: Codec<S>; receive: Codec<V> }): Subscription<S, V, undefined>;
export function subscription<S, V, I>(def: {
  start: Codec<S>;
  receive: Codec<V>;
  interrupt: Codec<I>;
}): Subscription<S, V, I>;
export function subscription<S, V, I>(def: {
  start: Codec<S>;
  receive: Codec<V>;
  interrupt?: Codec<I>;
}): Subscription<S, V, I> | Subscription<S, V, undefined> {
  const subscriptionOf = <D>(interrupt: Codec<D>): Subscription<S, V, D> =>
    method(subscriptionLegs(def.start, def.receive, interrupt), subscriptionLeg);
  return def.interrupt === undefined ? subscriptionOf(_void) : subscriptionOf(def.interrupt);
}

/** Any method, as a schema holds it. What its sides send is told apart by tag, whatever its payload types. */
export type AnyMethod = {
  readonly message: { readonly dec: (data: Uint8Array) => { tag: string } };
  readonly leg: (data: Uint8Array) => { tag: string };
};

/** A schema's sections: section names to method names to methods. */
export type Sections = Readonly<Record<string, Readonly<Record<string, AnyMethod>>>>;

/** Any one method of `T`, as a union. */
export type MethodOf<T extends Sections> = { [K in keyof T]: T[K][keyof T[K]] }[keyof T];

/** Where a method sits: its names and its wire ids. */
export type Address = {
  section: string;
  method: string;
  sectionId: number;
  methodId: number;
};

/** Whether a call names the method at `address`. */
export const sameMethod = (address: Address, call: { sectionId: number; methodId: number }): boolean =>
  address.sectionId === call.sectionId && address.methodId === call.methodId;

/** A checked schema, which places each of its methods. */
export type Schema<H, T extends Sections> = {
  readonly version: number;
  readonly hello: Codec<H>;
  readonly sections: T;
  /** Where `method` sits. Throws for a method of another schema, which is the caller's mistake. */
  readonly addressOf: (method: AnyMethod) => Address;
  /** The method at these wire ids, or undefined when the schema has none there. */
  readonly methodAt: (sectionId: number, methodId: number) => AnyMethod | undefined;
};

// Ids are bytes on the wire.
const MAX_IDS = 256;
const MAX_VERSION = 255;

/**
 * Checks a schema and fixes its wire ids from the order of `sections` and of each section's methods. Each method may sit in
 * one place only, since the transport finds its place by the method itself.
 */
export function defineSchema<H, T extends Sections>(def: {
  version: number;
  hello: Codec<H>;
  sections: T;
}): Schema<H, T> {
  if (!Number.isInteger(def.version) || def.version < 0 || def.version > MAX_VERSION) {
    throw new RangeError(`version must be an integer from 0 to ${String(MAX_VERSION)}, got ${String(def.version)}`);
  }
  const sections = Object.entries(def.sections);
  if (sections.length > MAX_IDS) {
    throw new RangeError(`a schema has at most ${String(MAX_IDS)} sections, got ${String(sections.length)}`);
  }

  const addresses = new Map<AnyMethod, Address>();
  const methods: AnyMethod[][] = [];
  for (const [section, ofSection] of sections) {
    const entries = Object.entries(ofSection);
    if (entries.length > MAX_IDS) {
      throw new RangeError(
        `section "${section}" has at most ${String(MAX_IDS)} methods, got ${String(entries.length)}`,
      );
    }
    const sectionId = methods.length;
    const inSection: AnyMethod[] = [];
    for (const [name, method] of entries) {
      const taken = addresses.get(method);
      if (taken !== undefined) {
        throw new Error(`${section}.${name} is the method already at ${taken.section}.${taken.method}`);
      }
      addresses.set(method, { section, method: name, sectionId, methodId: inSection.length });
      inSection.push(method);
    }
    methods.push(inSection);
  }

  return {
    version: def.version,
    hello: def.hello,
    sections: def.sections,
    addressOf(method) {
      const address = addresses.get(method);
      if (address === undefined) {
        throw new Error('The method is not one of this schema');
      }
      return address;
    },
    methodAt: (sectionId, methodId) => methods[sectionId]?.[methodId],
  };
}

/** What each side of a method sends, by name. */
export type MethodTypes<M> =
  M extends Request<infer P, infer R, infer E>
    ? RequestTypes<P, R, E>
    : M extends Subscription<infer S, infer V, infer I>
      ? SubscriptionTypes<S, V, I>
      : never;

/** A method's own error: a request's `error`, or a subscription's `interrupt` reason as a whole. */
export type DomainError<M> =
  M extends Request<infer _P, infer _R, infer E> ? E : M extends Subscription<infer _S, infer _V, infer I> ? I : never;
