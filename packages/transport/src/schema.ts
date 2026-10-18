// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A schema nests traits, then methods. A method is a request or a subscription, built from the codecs of what its sides
// send, and carries its types, so the transport calls and serves it by the method itself. Wire ids are positions.

import { Enum, _void, type Codec } from 'scale-ts';
import type { CallError, Result, Variant } from './result.js';
import { callError, frameOf, noDomainError, outcome, type Frame } from './wire.js';

/** What a request's sides send: its payload, then the answer. */
export interface RequestTypes<P, R, E> {
  request: P;
  response: Result<R, CallError<E>>;
}

/** What a subscription's sides send: its start, its values, then its end, or the caller's stop. */
export interface SubscriptionTypes<S, V, I> {
  start: S;
  receive: V;
  interrupt: Result<undefined, CallError<I>>;
  stop: undefined;
}

/** A request's message, one of what its sides send. */
export type RequestMessage<P, R, E> = Variant<RequestTypes<P, R, E>>;

/** A subscription's message, one of what its sides send. */
export type SubscriptionMessage<S, V, I> = Variant<SubscriptionTypes<S, V, I>>;

/** A method: the codec of what its sides send, and of the frames that carry it. */
interface Method<M> {
  readonly message: Codec<M>;
  readonly frame: Codec<Frame<M>>;
}

/** A request method. `E` is its own error, `never` when it declares none. */
export type Request<P, R, E> = Method<RequestMessage<P, R, E>>;

/** A subscription method. `I` is its own end reason, `never` when it declares none. */
export type Subscription<S, V, I> = Method<SubscriptionMessage<S, V, I>>;

const method = <M>(message: Codec<M>): Method<M> => ({ message, frame: frameOf(message) });

/** Declares a request. `error` is the method's own error, and a method without one never answers `Domain`. */
export function request<P, R>(def: { request: Codec<P>; response: Codec<R> }): Request<P, R, never>;
export function request<P, R, E>(def: { request: Codec<P>; response: Codec<R>; error: Codec<E> }): Request<P, R, E>;
export function request<P, R, E>(def: {
  request: Codec<P>;
  response: Codec<R>;
  error?: Codec<E>;
}): Request<P, R, E> | Request<P, R, never> {
  const requestOf = <D>(error: Codec<D>): Request<P, R, D> =>
    method(Enum({ request: def.request, response: outcome(def.response, callError(error)) }));
  return def.error === undefined ? requestOf(noDomainError) : requestOf(def.error);
}

/** Declares a subscription. `interrupt` is the method's own end reason, and one without it never ends with `Domain`. */
export function subscription<S, V>(def: { start: Codec<S>; receive: Codec<V> }): Subscription<S, V, never>;
export function subscription<S, V, I>(def: {
  start: Codec<S>;
  receive: Codec<V>;
  interrupt: Codec<I>;
}): Subscription<S, V, I>;
export function subscription<S, V, I>(def: {
  start: Codec<S>;
  receive: Codec<V>;
  interrupt?: Codec<I>;
}): Subscription<S, V, I> | Subscription<S, V, never> {
  const subscriptionOf = <D>(reason: Codec<D>): Subscription<S, V, D> =>
    method(Enum({ start: def.start, receive: def.receive, interrupt: outcome(_void, callError(reason)), stop: _void }));
  return def.interrupt === undefined ? subscriptionOf(noDomainError) : subscriptionOf(def.interrupt);
}

/** Any method, as a schema holds it. What its sides send is told apart by tag, whatever its payload types. */
export interface AnyMethod {
  readonly message: { readonly dec: (data: Uint8Array) => { tag: string } };
}

/** A schema's traits: trait names to method names to methods. */
export type Traits = Readonly<Record<string, Readonly<Record<string, AnyMethod>>>>;

/** Where a method sits: its names and its wire ids. */
export interface Address {
  trait: string;
  method: string;
  traitId: number;
  methodId: number;
}

/** A checked schema. `addresses` places each of its methods. */
export interface Schema<H, T extends Traits> {
  readonly version: number;
  readonly hello: Codec<H>;
  readonly traits: T;
  readonly addresses: ReadonlyMap<AnyMethod, Address>;
}

// Ids are bytes on the wire.
const MAX_IDS = 256;
const MAX_VERSION = 255;

/**
 * Checks a schema and fixes its wire ids from the order of `traits` and of each trait's methods. Each method may sit in
 * one place only, since the transport finds its place by the method itself.
 */
export function defineSchema<H, T extends Traits>(def: { version: number; hello: Codec<H>; traits: T }): Schema<H, T> {
  if (!Number.isInteger(def.version) || def.version < 0 || def.version > MAX_VERSION) {
    throw new RangeError(`version must be an integer from 0 to ${String(MAX_VERSION)}, got ${String(def.version)}`);
  }
  const traits = Object.entries(def.traits);
  if (traits.length > MAX_IDS) {
    throw new RangeError(`a schema has at most ${String(MAX_IDS)} traits, got ${String(traits.length)}`);
  }
  const addresses = new Map<AnyMethod, Address>();
  traits.forEach(([trait, methods], traitId) => {
    const entries = Object.entries(methods);
    if (entries.length > MAX_IDS) {
      throw new RangeError(`trait "${trait}" has at most ${String(MAX_IDS)} methods, got ${String(entries.length)}`);
    }
    entries.forEach(([name, method], methodId) => {
      const placed = addresses.get(method);
      if (placed !== undefined) {
        throw new Error(`${trait}.${name} is the method already at ${placed.trait}.${placed.method}`);
      }
      addresses.set(method, { trait, method: name, traitId, methodId });
    });
  });
  return { version: def.version, hello: def.hello, traits: def.traits, addresses };
}

/** What each side of a method sends, by name. */
export type MethodTypes<M> =
  M extends Request<infer P, infer R, infer E>
    ? RequestTypes<P, R, E>
    : M extends Subscription<infer S, infer V, infer I>
      ? SubscriptionTypes<S, V, I>
      : never;

/** A method's own error: a request's `error`, or a subscription's `interrupt` reason. */
export type DomainError<M> =
  M extends Request<infer _P, infer _R, infer E> ? E : M extends Subscription<infer _S, infer _V, infer I> ? I : never;
