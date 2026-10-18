// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Enum, Struct, _void, str, u32 } from 'scale-ts';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CallError, Result } from './result.js';
import { defineSchema, request, subscription, type DomainError, type MethodTypes, type Traits } from './schema.js';

const label = Struct({ label: str });
const frameFailure = Enum({ fatal: _void, released: _void });

const owner = request({ request: label, response: str });
const changes = subscription({ start: label, receive: str });
const status = subscription({ start: _void, receive: _void, interrupt: frameFailure });
const reload = request({ request: _void, response: _void, error: frameFailure });

const s = defineSchema({
  version: 2,
  hello: u32,
  traits: {
    resolve: { owner, changes },
    frame: { status, reload },
  },
});

const traitsOf = (count: number, methods: number): Traits =>
  Object.fromEntries(
    Array.from({ length: count }, (_, t) => [
      `trait${String(t)}`,
      Object.fromEntries(
        Array.from({ length: methods }, (__, m) => [
          `method${String(m)}`,
          request({ request: _void, response: _void }),
        ]),
      ),
    ]),
  );

describe('schema', () => {
  it('As a schema author, I nest traits and methods and their places follow their order', () => {
    // Given
    const schema = s;

    // When
    const places = [owner, changes, status, reload].map(method => schema.addresses.get(method));

    // Then
    expect(places).toEqual([
      { trait: 'resolve', method: 'owner', traitId: 0, methodId: 0 },
      { trait: 'resolve', method: 'changes', traitId: 0, methodId: 1 },
      { trait: 'frame', method: 'status', traitId: 1, methodId: 0 },
      { trait: 'frame', method: 'reload', traitId: 1, methodId: 1 },
    ]);
    expect(schema.traits.resolve.owner).toBe(owner);
    expect(schema.version).toBe(2);
  });

  it('As a schema author, I change my traits record after defining the schema and its places stay as they were', () => {
    // Given
    const traits: Record<string, Record<string, typeof owner | typeof status | typeof reload>> = {
      resolve: { owner },
      frame: { status },
    };
    const schema = defineSchema({ version: 0, hello: _void, traits });

    // When
    delete traits['resolve'];
    traits['later'] = { owner: reload };

    // Then
    expect(schema.addresses.get(owner)).toEqual({ trait: 'resolve', method: 'owner', traitId: 0, methodId: 0 });
    expect(schema.addresses.get(reload)).toBeUndefined();
  });

  it('As a schema author, I am refused a schema with too many traits or methods, or a version that is not 0 to 255', () => {
    // Given
    const fits = { version: 255, hello: _void, traits: traitsOf(256, 1) };
    const fitsMethods = { version: 0, hello: _void, traits: traitsOf(1, 256) };

    // When
    const tooManyTraits = () => defineSchema({ version: 0, hello: _void, traits: traitsOf(257, 1) });
    const tooManyMethods = () => defineSchema({ version: 0, hello: _void, traits: traitsOf(1, 257) });
    const versionOver = () => defineSchema({ version: 256, hello: _void, traits: {} });
    const versionUnder = () => defineSchema({ version: -1, hello: _void, traits: {} });
    const versionFraction = () => defineSchema({ version: 1.5, hello: _void, traits: {} });

    // Then
    expect(() => defineSchema(fits)).not.toThrow();
    expect(() => defineSchema(fitsMethods)).not.toThrow();
    expect(tooManyTraits).toThrow('at most 256 traits, got 257');
    expect(tooManyMethods).toThrow('trait "trait0" has at most 256 methods, got 257');
    expect(versionOver).toThrow('version must be an integer from 0 to 255, got 256');
    expect(versionUnder).toThrow('got -1');
    expect(versionFraction).toThrow('got 1.5');
  });

  it('As a schema author, I am refused a method placed twice, since the transport finds a method by itself', () => {
    // Given
    const traits = { resolve: { owner }, frame: { reload: owner } };

    // When
    const twice = () => defineSchema({ version: 0, hello: _void, traits });

    // Then
    expect(twice).toThrow('frame.reload is the method already at resolve.owner');
  });

  it('As a schema author, I read what each side of a method sends, and its own error, from the method', () => {
    // Given
    type Owner = MethodTypes<typeof owner>;
    type Changes = MethodTypes<typeof changes>;
    type FrameFailure = { tag: 'fatal'; value: undefined } | { tag: 'released'; value: undefined };

    // Then
    expectTypeOf<Owner>().toEqualTypeOf<{
      request: { label: string };
      response: Result<string, CallError<never>>;
    }>();
    expectTypeOf<Changes>().toEqualTypeOf<{
      start: { label: string };
      receive: string;
      interrupt: Result<undefined, CallError<never>>;
      stop: undefined;
    }>();
    expectTypeOf<MethodTypes<typeof status>['interrupt']>().toEqualTypeOf<Result<undefined, CallError<FrameFailure>>>();
    expectTypeOf<DomainError<typeof status>>().toEqualTypeOf<FrameFailure>();
    expectTypeOf<DomainError<typeof reload>>().toEqualTypeOf<FrameFailure>();
    expectTypeOf<DomainError<typeof owner>>().toBeNever();
    expect(s.hello).toBe(u32);
  });
});
