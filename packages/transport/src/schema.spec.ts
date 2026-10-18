// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, expectTypeOf, it } from 'vitest';
import { codec, none } from './codec.js';
import type { Codec } from './codec.js';
import type { CallError, Result } from './result.js';
import { defineSchema, request, schemaVersion, subscription, wireOf, type Schema } from './schema.js';
import type {
  DomainError,
  HelloOf,
  MethodName,
  MethodTypes,
  RequestMethodName,
  SubscriptionMethodName,
  TraitName,
} from './schema.js';

// The schema checks only the shape, so the codecs never run here.
const fake = <T>(): Codec<T> =>
  codec<T>(
    () => new Uint8Array(0),
    () => {
      throw new Error('not decoded in these tests');
    },
  );

const label = fake<{ label: string }>();
const nullableString = fake<string | null>();
const change = fake<{ owner: string }>();
const frameFailure = fake<'fatal' | 'released'>();
const peerId = fake<number>();

const s = defineSchema({
  version: 2,
  hello: peerId,
  traits: {
    resolve: {
      owner: request({ request: label, response: nullableString }),
      changes: subscription({ start: label, receive: change }),
    },
    frame: {
      status: subscription({ start: none, receive: none, interrupt: frameFailure }),
      reload: request({ request: none, response: none, error: frameFailure }),
    },
  },
});

const withoutHello = defineSchema({
  version: 1,
  traits: { resolve: { owner: request({ request: label, response: nullableString }) } },
});

const traitsOf = (count: number, methods: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, t) => [
      `trait${String(t)}`,
      Object.fromEntries(
        Array.from({ length: methods }, (__, m) => [`method${String(m)}`, request({ request: none, response: none })]),
      ),
    ]),
  );

/** The trait and method ids a message on the method goes out with. */
const idsOf = (schema: Schema, trait: string, method: string, leg: 'request' | 'stop'): number[] => {
  const data = wireOf(schema).encode({ trait, method, leg, id: 0, value: undefined });
  return [...new Uint8Array(data).slice(4, 6)];
};

describe('schema', () => {
  it('As a schema author, I nest traits and methods and the ids follow their order', () => {
    // Given
    const schema = s;

    // When
    const ids = [
      idsOf(schema, 'resolve', 'owner', 'request'),
      idsOf(schema, 'resolve', 'changes', 'stop'),
      idsOf(schema, 'frame', 'status', 'stop'),
      idsOf(schema, 'frame', 'reload', 'request'),
    ];

    // Then
    expect(ids).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
    expect(schemaVersion(schema)).toBe(2);
    expect(schemaVersion(withoutHello)).toBe(1);
  });

  it('As a schema author, I change my traits record after defining the schema and its ids stay as they were', () => {
    // Given
    const owner = request({ request: label, response: nullableString });
    const status = subscription({ start: none, receive: none, interrupt: frameFailure });
    const traits: Record<string, Record<string, typeof owner | typeof status>> = {
      resolve: { owner },
      frame: { status },
    };
    const schema = defineSchema({ version: 0, traits });

    // When
    delete traits['resolve'];
    traits['later'] = { owner };

    // Then
    expect(idsOf(schema, 'resolve', 'owner', 'request')).toEqual([0, 0]);
    expect(idsOf(schema, 'frame', 'status', 'stop')).toEqual([1, 0]);
    expect(() => idsOf(schema, 'later', 'owner', 'request')).toThrow();
  });

  it('As a schema author, I am refused a schema with too many traits or methods, or a version that is not 0 to 255', () => {
    // Given
    const fits = { version: 255, traits: traitsOf(255, 1) };
    const fitsMethods = { version: 0, traits: traitsOf(1, 256) };

    // When
    const tooManyTraits = () => defineSchema({ version: 0, traits: traitsOf(256, 1) });
    const tooManyMethods = () => defineSchema({ version: 0, traits: traitsOf(1, 257) });
    const versionOver = () => defineSchema({ version: 256, traits: {} });
    const versionUnder = () => defineSchema({ version: -1, traits: {} });
    const versionFraction = () => defineSchema({ version: 1.5, traits: {} });

    // Then
    expect(() => defineSchema(fits)).not.toThrow();
    expect(() => defineSchema(fitsMethods)).not.toThrow();
    expect(idsOf(defineSchema(fits), 'trait254', 'method0', 'request')).toEqual([254, 0]);
    expect(idsOf(defineSchema(fitsMethods), 'trait0', 'method255', 'request')).toEqual([0, 255]);
    expect(tooManyTraits).toThrow('at most 255 traits, got 256');
    expect(tooManyMethods).toThrow('trait "trait0" has at most 256 methods, got 257');
    expect(versionOver).toThrow('version must be an integer from 0 to 255, got 256');
    expect(versionUnder).toThrow('got -1');
    expect(versionFraction).toThrow('got 1.5');
  });

  it('As a schema author, I am refused a trait or method name that is no identifier, so no id can leave its place', () => {
    // Given
    const method = request({ request: none, response: none });

    // When
    const integerTrait = () => defineSchema({ version: 0, traits: { names: { method }, '3': { method } } });
    const integerMethod = () => defineSchema({ version: 0, traits: { names: { first: method, '0': method } } });
    const dotted = () => defineSchema({ version: 0, traits: { 'a.b': { method } } });
    const empty = () => defineSchema({ version: 0, traits: { names: { '': method } } });
    const identifiers = () => defineSchema({ version: 0, traits: { v2: { m1: method }, _$x: { method } } });

    // Then
    expect(integerTrait).toThrow('trait "3" must be an identifier');
    expect(integerMethod).toThrow('method "0" of trait "names" must be an identifier');
    expect(dotted).toThrow('trait "a.b" must be an identifier');
    expect(empty).toThrow('method "" of trait "names" must be an identifier');
    expect(identifiers).not.toThrow();
  });

  it('As a schema author, I define a schema without type arguments and read every name, payload and answer type from it', () => {
    // Given
    type S = typeof s;

    // When
    type Owner = MethodTypes<S, 'resolve', 'owner'>;
    type Changes = MethodTypes<S, 'resolve', 'changes'>;
    type Status = MethodTypes<S, 'frame', 'status'>;
    type Reload = MethodTypes<S, 'frame', 'reload'>;

    // Then
    expectTypeOf<TraitName<S>>().toEqualTypeOf<'resolve' | 'frame'>();
    expectTypeOf<MethodName<S, 'resolve'>>().toEqualTypeOf<'owner' | 'changes'>();
    expectTypeOf<RequestMethodName<S, 'resolve'>>().toEqualTypeOf<'owner'>();
    expectTypeOf<SubscriptionMethodName<S, 'resolve'>>().toEqualTypeOf<'changes'>();
    expectTypeOf<RequestMethodName<S, 'frame'>>().toEqualTypeOf<'reload'>();
    expectTypeOf<SubscriptionMethodName<S, 'frame'>>().toEqualTypeOf<'status'>();
    expectTypeOf<Owner>().toEqualTypeOf<{
      request: { label: string };
      response: Result<string | null, CallError<never>>;
    }>();
    expectTypeOf<Changes>().toEqualTypeOf<{
      start: { label: string };
      receive: { owner: string };
      interrupt: Result<void, CallError<never>>;
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a stop carries no value, which is the shape under test
      stop: void;
    }>();
    expectTypeOf<Status['interrupt']>().toEqualTypeOf<Result<void, CallError<'fatal' | 'released'>>>();
    expectTypeOf<Reload['response']>().toEqualTypeOf<Result<void, CallError<'fatal' | 'released'>>>();
    expectTypeOf<DomainError<S, 'frame', 'status'>>().toEqualTypeOf<'fatal' | 'released'>();
    expectTypeOf<DomainError<S, 'frame', 'reload'>>().toEqualTypeOf<'fatal' | 'released'>();
    expectTypeOf<DomainError<S, 'resolve', 'owner'>>().toBeNever();
    expectTypeOf<HelloOf<S>>().toEqualTypeOf<number>();
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a schema without hello sends none
    expectTypeOf<HelloOf<typeof withoutHello>>().toEqualTypeOf<void>();
  });

  it('As a schema author, I misspell a trait or method and get a type error', () => {
    // Given
    type S = typeof s;

    // When
    // @ts-expect-error a method of another trait
    type Misspelt = MethodTypes<S, 'frame', 'owner'>;

    // Then
    expectTypeOf<Misspelt>().toBeNever();
    // @ts-expect-error a trait the schema lacks
    expectTypeOf<MethodTypes<S, 'resolv', 'owner'>>();
    // @ts-expect-error a method the trait lacks
    expectTypeOf<MethodTypes<S, 'resolve', 'ownr'>>();
    // @ts-expect-error a trait the schema lacks
    expectTypeOf<MethodName<S, 'resolv'>>();
  });
});
