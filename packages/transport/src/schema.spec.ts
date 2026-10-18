// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, expectTypeOf, it } from 'vitest';
import { codec, none } from './codec.js';
import type { Codec } from './codec.js';
import type { CallError, Result } from './result.js';
import {
  defineSchema,
  methodAddress,
  methodAt,
  methodNamesAt,
  request,
  schemaHello,
  schemaVersion,
  subscription,
} from './schema.js';
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

describe('schema', () => {
  it('As a schema author, I nest traits and methods and the ids follow their order', () => {
    // Given
    const schema = s;

    // When
    const addresses = [
      methodAddress(schema, 'resolve', 'owner'),
      methodAddress(schema, 'resolve', 'changes'),
      methodAddress(schema, 'frame', 'status'),
      methodAddress(schema, 'frame', 'reload'),
    ];

    // Then
    expect(addresses).toEqual([
      { traitId: 0, methodId: 0 },
      { traitId: 0, methodId: 1 },
      { traitId: 1, methodId: 0 },
      { traitId: 1, methodId: 1 },
    ]);
    expect(methodAt(schema, 0, 0)?.kind).toBe('request');
    expect(methodAt(schema, 0, 1)?.kind).toBe('subscription');
    expect(methodAt(schema, 1, 0)?.kind).toBe('subscription');
    expect(methodAt(schema, 1, 1)?.kind).toBe('request');
    expect(methodAt(schema, 0, 2)).toBeUndefined();
    expect(methodAt(schema, 2, 0)).toBeUndefined();
    expect(methodAt(schema, 255, 0)).toBeUndefined();
  });

  it('As the library, I read the version, the hello codec and the names behind an id from a schema', () => {
    // Given
    const schema = s;

    // When
    const names = [methodNamesAt(schema, 0, 1), methodNamesAt(schema, 1, 0)];

    // Then
    expect(names).toEqual([
      { trait: 'resolve', method: 'changes' },
      { trait: 'frame', method: 'status' },
    ]);
    expect(methodNamesAt(schema, 0, 2)).toBeUndefined();
    expect(methodNamesAt(schema, 255, 255)).toBeUndefined();
    expect(schemaVersion(schema)).toBe(2);
    expect(schemaHello(schema)).toBe(peerId);
    expect(schemaVersion(withoutHello)).toBe(1);
    expect(schemaHello(withoutHello)).toBeUndefined();
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
    expect(methodAddress(schema, 'resolve', 'owner')).toEqual({ traitId: 0, methodId: 0 });
    expect(methodAt(schema, 0, 0)).toEqual({
      kind: 'request',
      request: label,
      response: nullableString,
      error: undefined,
    });
    expect(methodAt(schema, 1, 0)).toEqual({
      kind: 'subscription',
      start: none,
      receive: none,
      interrupt: frameFailure,
    });
    expect(methodAt(schema, 2, 0)).toBeUndefined();
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
    expect(methodAddress(defineSchema(fits), 'trait254', 'method0')).toEqual({ traitId: 254, methodId: 0 });
    expect(methodAddress(defineSchema(fitsMethods), 'trait0', 'method255')).toEqual({ traitId: 0, methodId: 255 });
    expect(tooManyTraits).toThrow('at most 255 traits, got 256');
    expect(tooManyMethods).toThrow('trait "trait0" has at most 256 methods, got 257');
    expect(versionOver).toThrow('version must be an integer from 0 to 255, got 256');
    expect(versionUnder).toThrow('got -1');
    expect(versionFraction).toThrow('got 1.5');
  });

  it('As a schema author, I am refused an integer-like trait or method name, so no id can leave its written place', () => {
    // Given
    const method = request({ request: none, response: none });

    // When
    const integerTrait = () => defineSchema({ version: 0, traits: { names: { method }, '3': { method } } });
    const integerMethod = () => defineSchema({ version: 0, traits: { names: { first: method, '0': method } } });
    const mixed = () => defineSchema({ version: 0, traits: { v2: { m1: method }, '01x': { method } } });

    // Then
    expect(integerTrait).toThrow('trait "3" must not be an integer');
    expect(integerMethod).toThrow('method "0" of trait "names" must not be an integer');
    expect(mixed).not.toThrow();
  });

  it('As a schema author, I define a schema without type arguments and read every name, payload and answer type from it', () => {
    // Given
    type S = typeof s;

    // When
    type Owner = MethodTypes<S, 'resolve', 'owner'>;
    type DotName = MethodTypes<S, 'resolve', 'changes'>;
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
    expectTypeOf<DotName>().toEqualTypeOf<{
      start: { label: string };
      receive: { owner: string };
      interrupt: Result<void, CallError<never>>;
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- the leg's shape is the one under test
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
    const misspelt = () =>
      // @ts-expect-error a method of another trait
      methodAddress(s, 'frame', 'owner');

    // Then
    // @ts-expect-error a trait the schema lacks
    expectTypeOf<MethodTypes<S, 'resolv', 'owner'>>();
    // @ts-expect-error a method the trait lacks
    expectTypeOf<MethodTypes<S, 'resolve', 'ownr'>>();
    // @ts-expect-error a trait the schema lacks
    expectTypeOf<MethodName<S, 'resolv'>>();
    expect(misspelt).toThrow('no method "owner" in trait "frame"');
  });
});
