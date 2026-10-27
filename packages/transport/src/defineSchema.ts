// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A schema nests sections, then methods. Wire ids are positions.

import type { Codec } from 'scale-ts';
import type { AnyMethod } from './method.js';

/** A schema's sections: section names to method names to methods. */
export type Sections = Readonly<Record<string, Readonly<Record<string, AnyMethod>>>>;

/** Any one method of `T`, as a union. */
export type MethodOf<T extends Sections> = { [Section in keyof T]: T[Section][keyof T[Section]] }[keyof T];

/** Where a method sits: its names and its wire ids. */
export type Address = {
  section: string;
  method: string;
  sectionId: number;
  methodId: number;
};

/** A checked schema, which places each of its methods. */
export type Schema<Hello, T extends Sections> = ReturnType<typeof defineSchema<Hello, T>>;

// Ids are bytes on the wire.
const MAX_IDS = 256;
const MAX_VERSION = 255;

/**
 * Checks a schema and fixes its wire ids from the order of `sections` and of each section's methods. Each method may
 * sit in one place only, since the transport finds its place by the method itself.
 */
export function defineSchema<Hello, T extends Sections>(definition: {
  version: number;
  hello: Codec<Hello>;
  sections: T;
}) {
  if (!Number.isInteger(definition.version) || definition.version < 0 || definition.version > MAX_VERSION) {
    throw new RangeError(
      `version must be an integer from 0 to ${String(MAX_VERSION)}, got ${String(definition.version)}`,
    );
  }
  const sections = Object.entries(definition.sections);
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
  const sectionNames = sections.map(([section]) => section).join(', ');

  function addressOf(method: AnyMethod): Address {
    const address = addresses.get(method);
    if (address === undefined) {
      throw new Error(`The method is not one of this schema's sections (${sectionNames})`);
    }
    return address;
  }

  function methodAt(sectionId: number, methodId: number): AnyMethod | undefined {
    return methods[sectionId]?.[methodId];
  }

  return {
    /** The schema's version, which the handshake checks. */
    version: definition.version,
    /** The codec of the hello each side sends in the handshake. */
    hello: definition.hello,
    /** The sections as the schema was defined with them. */
    sections: definition.sections,
    /** Where `method` sits. Throws for a method of another schema, which is the caller's mistake. */
    addressOf,
    /** The method at these wire ids, or undefined when the schema has none there. */
    methodAt,
  } as const;
}

/** Whether a call names the method at `address`. */
export function isSameMethod(address: Address, call: { sectionId: number; methodId: number }): boolean {
  return address.sectionId === call.sectionId && address.methodId === call.methodId;
}
