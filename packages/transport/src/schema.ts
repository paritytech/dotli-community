// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A schema nests traits, then methods, then a request or a subscription. Wire ids are positions, fixed once by
// `defineSchema`, which composes the message codec. The public types carry the payload types only, and the codecs stay
// behind library accessors.

import { none, type Codec } from './codec.js';
import type { CallError, Result } from './result.js';
import { createWire, requestWire, subscriptionWire, type MethodWire, type Wire } from './wire.js';

// Phantom keys. No value ever holds them, so only these types can read what a def or a schema carries.
declare const requestTypes: unique symbol;
declare const subscriptionTypes: unique symbol;
declare const schemaTypes: unique symbol;

/** A request method: one payload in, one `Result` back. Build it with `request`. */
export interface RequestDef<P, R, E> {
  readonly [requestTypes]: { request: P; response: R; error: E };
}

/** A subscription method: one start payload, then values until it is interrupted or stopped. */
export interface SubscriptionDef<S, V, I> {
  readonly [subscriptionTypes]: { start: S; receive: V; interrupt: I };
}

// Any def, typed loosely enough that a factory call inside `traits` infers nothing from it. A stricter context would
// widen an omitted `error` or `interrupt` from `never` to `unknown`.
export type MethodDef = { readonly [requestTypes]: object } | { readonly [subscriptionTypes]: object };

/** The record a schema author passes as `traits`: trait names to method names to defs. */
export type Traits = Record<string, Record<string, MethodDef>>;

/** A checked schema with fixed wire ids. Its names and payload types are read through the type helpers. */
export interface Schema<T extends Traits = Traits, H = unknown> {
  readonly [schemaTypes]: { traits: T; hello: H };
}

interface SchemaImpl {
  readonly version: number;
  readonly wire: Wire;
}

// Trait id 255 is the library's own, so user traits take 0 to 254, and methods take every u8.
const MAX_TRAITS = 255;
const MAX_METHODS = 256;
const MAX_VERSION = 255;

// An identifier keeps its written position among object keys, which an integer-like name would not, and never takes
// the name of the library's own trait.
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function checkName(name: string, label: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new RangeError(`${label} must be an identifier`);
  }
}

/** Declares a request. `error` is the method's own error type and defaults to `never`. */
export function request<P, R, E = never>(def: {
  request: Codec<P>;
  response: Codec<R>;
  error?: Codec<E>;
}): RequestDef<P, R, E> {
  const wire = requestWire(def.request as Codec<unknown>, def.response as Codec<unknown>, def.error as Codec<unknown>);
  return wire as unknown as RequestDef<P, R, E>;
}

/** Declares a subscription. `interrupt` is the method's own end reason and defaults to `never`. */
export function subscription<S, V, I = never>(def: {
  start: Codec<S>;
  receive: Codec<V>;
  interrupt?: Codec<I>;
}): SubscriptionDef<S, V, I> {
  const wire = subscriptionWire(
    def.start as Codec<unknown>,
    def.receive as Codec<unknown>,
    def.interrupt as Codec<unknown>,
  );
  return wire as unknown as SubscriptionDef<S, V, I>;
}

/**
 * Checks a schema and fixes its wire ids from the order of `traits` and of each trait's methods. Later changes to the
 * record do not move them.
 */
export function defineSchema<T extends Traits, H = void>(def: {
  version: number;
  hello?: Codec<H>;
  traits: T;
}): Schema<T, H> {
  if (!Number.isInteger(def.version) || def.version < 0 || def.version > MAX_VERSION) {
    throw new RangeError(`version must be an integer from 0 to ${String(MAX_VERSION)}, got ${String(def.version)}`);
  }
  const traits = Object.entries(def.traits);
  if (traits.length > MAX_TRAITS) {
    throw new RangeError(`a schema has at most ${String(MAX_TRAITS)} traits, got ${String(traits.length)}`);
  }
  for (const [name, methods] of traits) {
    checkName(name, `trait "${name}"`);
    const methodNames = Object.keys(methods);
    if (methodNames.length > MAX_METHODS) {
      throw new RangeError(
        `trait "${name}" has at most ${String(MAX_METHODS)} methods, got ${String(methodNames.length)}`,
      );
    }
    for (const methodName of methodNames) {
      checkName(methodName, `method "${methodName}" of trait "${name}"`);
    }
  }
  const hello = (def.hello ?? none) as Codec<unknown>;
  const impl: SchemaImpl = Object.freeze({
    version: def.version,
    wire: createWire(def.version, hello, def.traits as unknown as Record<string, Record<string, MethodWire>>),
  });
  return impl as unknown as Schema<T, H>;
}

type TraitsOf<S extends Schema> = S[typeof schemaTypes]['traits'];
type DefOf<S extends Schema, T extends TraitName<S>, M extends MethodName<S, T>> = TraitsOf<S>[T][M];

/** The names of a schema's traits. */
export type TraitName<S extends Schema> = keyof TraitsOf<S> & string;

/** The names of a trait's methods. */
export type MethodName<S extends Schema, T extends TraitName<S>> = keyof TraitsOf<S>[T] & string;

/** The names of a trait's request methods. */
export type RequestMethodName<S extends Schema, T extends TraitName<S>> = {
  [M in MethodName<S, T>]: TraitsOf<S>[T][M] extends RequestDef<unknown, unknown, unknown> ? M : never;
}[MethodName<S, T>];

/** The names of a trait's subscription methods. */
export type SubscriptionMethodName<S extends Schema, T extends TraitName<S>> = {
  [M in MethodName<S, T>]: TraitsOf<S>[T][M] extends SubscriptionDef<unknown, unknown, unknown> ? M : never;
}[MethodName<S, T>];

/** What each side of a method sends and receives. A request answers and a subscription ends with a `Result`. */
export type MethodTypes<S extends Schema, T extends TraitName<S>, M extends MethodName<S, T>> =
  DefOf<S, T, M> extends RequestDef<infer P, infer R, infer E>
    ? { request: P; response: Result<R, CallError<E>> }
    : DefOf<S, T, M> extends SubscriptionDef<infer St, infer V, infer I>
      ? // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- stop carries no value by contract
        { start: St; receive: V; interrupt: Result<void, CallError<I>>; stop: void }
      : never;

/** A method's own error: a request's `error`, or a subscription's `interrupt` reason. */
export type DomainError<S extends Schema, T extends TraitName<S>, M extends MethodName<S, T>> =
  DefOf<S, T, M> extends RequestDef<unknown, unknown, infer E>
    ? E
    : DefOf<S, T, M> extends SubscriptionDef<unknown, unknown, infer I>
      ? I
      : never;

/** The value each side sends in the handshake, or `void` when the schema declares no hello. */
export type HelloOf<S extends Schema> = S[typeof schemaTypes]['hello'];

const internals = (schema: Schema): SchemaImpl => schema as unknown as SchemaImpl;

/** The schema's message codec. */
export function wireOf(schema: Schema): Wire {
  return internals(schema).wire;
}

/** The version the handshake carries. */
export function schemaVersion(schema: Schema): number {
  return internals(schema).version;
}
