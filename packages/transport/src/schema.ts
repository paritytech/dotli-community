// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A schema nests traits, then methods, then a request or a subscription. Wire ids are positions, fixed once by
// `defineSchema`. The public types carry the payload types only, and the codecs stay behind library accessors.

import type { Codec } from './codec.js';
import type { CallError, Result } from './result.js';

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

/** What the library reads from a request def. */
export interface RequestImpl {
  readonly kind: 'request';
  readonly request: Codec<unknown>;
  readonly response: Codec<unknown>;
  readonly error: Codec<unknown> | undefined;
}

/** What the library reads from a subscription def. */
export interface SubscriptionImpl {
  readonly kind: 'subscription';
  readonly start: Codec<unknown>;
  readonly receive: Codec<unknown>;
  readonly interrupt: Codec<unknown> | undefined;
}

export type MethodImpl = RequestImpl | SubscriptionImpl;

interface TraitEntry {
  readonly name: string;
  readonly methodNames: readonly string[];
  readonly methods: readonly MethodImpl[];
  readonly methodIds: ReadonlyMap<string, number>;
}

interface SchemaImpl {
  readonly version: number;
  readonly hello: Codec<unknown> | undefined;
  readonly traits: readonly TraitEntry[];
  readonly traitIds: ReadonlyMap<string, number>;
}

// Trait id 255 is the library's own, so user traits take 0 to 254, and methods take every u8.
const MAX_TRAITS = 255;
const MAX_METHODS = 256;
const MAX_VERSION = 255;

// JavaScript lists integer-like keys first and in numeric order, so such a name would not keep its written position.
const INTEGER_LIKE = /^\d+$/;

function checkName(name: string, label: string): void {
  if (INTEGER_LIKE.test(name)) {
    throw new RangeError(`${label} must not be an integer, since its id would not follow the written order`);
  }
}

/** Declares a request. `error` is the method's own error type and defaults to `never`. */
export function request<P, R, E = never>(def: {
  request: Codec<P>;
  response: Codec<R>;
  error?: Codec<E>;
}): RequestDef<P, R, E> {
  const impl: RequestImpl = Object.freeze({
    kind: 'request',
    request: def.request as Codec<unknown>,
    response: def.response as Codec<unknown>,
    error: def.error as Codec<unknown> | undefined,
  });
  return impl as unknown as RequestDef<P, R, E>;
}

/** Declares a subscription. `interrupt` is the method's own end reason and defaults to `never`. */
export function subscription<S, V, I = never>(def: {
  start: Codec<S>;
  receive: Codec<V>;
  interrupt?: Codec<I>;
}): SubscriptionDef<S, V, I> {
  const impl: SubscriptionImpl = Object.freeze({
    kind: 'subscription',
    start: def.start as Codec<unknown>,
    receive: def.receive as Codec<unknown>,
    interrupt: def.interrupt as Codec<unknown> | undefined,
  });
  return impl as unknown as SubscriptionDef<S, V, I>;
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
  const traitEntries = Object.entries(def.traits);
  if (traitEntries.length > MAX_TRAITS) {
    throw new RangeError(`a schema has at most ${String(MAX_TRAITS)} traits, got ${String(traitEntries.length)}`);
  }
  const traits = traitEntries.map(([name, methods]): TraitEntry => {
    checkName(name, `trait "${name}"`);
    const methodEntries = Object.entries(methods);
    if (methodEntries.length > MAX_METHODS) {
      throw new RangeError(
        `trait "${name}" has at most ${String(MAX_METHODS)} methods, got ${String(methodEntries.length)}`,
      );
    }
    for (const [methodName] of methodEntries) {
      checkName(methodName, `method "${methodName}" of trait "${name}"`);
    }
    return Object.freeze({
      name,
      methodNames: Object.freeze(methodEntries.map(([methodName]) => methodName)),
      methods: Object.freeze(methodEntries.map(([, method]) => method as unknown as MethodImpl)),
      methodIds: new Map(methodEntries.map(([methodName], id) => [methodName, id])),
    });
  });
  const impl: SchemaImpl = Object.freeze({
    version: def.version,
    hello: def.hello as Codec<unknown> | undefined,
    traits: Object.freeze(traits),
    traitIds: new Map(traitEntries.map(([name], id) => [name, id])),
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

/** The wire ids of a method. Throws on a name the schema lacks, which the types already rule out. */
export function methodAddress<S extends Schema, T extends TraitName<S>>(
  schema: S,
  trait: T,
  method: MethodName<S, T>,
): { traitId: number; methodId: number } {
  const impl = internals(schema);
  const traitId = impl.traitIds.get(trait);
  const methodId = traitId === undefined ? undefined : impl.traits[traitId]?.methodIds.get(method);
  if (traitId === undefined || methodId === undefined) {
    throw new Error(`no method "${method}" in trait "${trait}"`);
  }
  return { traitId, methodId };
}

/** The method at a pair of wire ids, or `undefined` when the schema has none there. */
export function methodAt(schema: Schema, traitId: number, methodId: number): MethodImpl | undefined {
  return internals(schema).traits[traitId]?.methods[methodId];
}

/** The method's names at a pair of wire ids, or `undefined` when the schema has none there. */
export function methodNamesAt(
  schema: Schema,
  traitId: number,
  methodId: number,
): { trait: string; method: string } | undefined {
  const trait = internals(schema).traits[traitId];
  const method = trait?.methodNames[methodId];
  return trait === undefined || method === undefined ? undefined : { trait: trait.name, method };
}

/** The version the handshake carries. */
export function schemaVersion(schema: Schema): number {
  return internals(schema).version;
}

/** The codec of the handshake's hello, or `undefined` when the schema declares none. */
export function schemaHello(schema: Schema): Codec<unknown> | undefined {
  return internals(schema).hello;
}
