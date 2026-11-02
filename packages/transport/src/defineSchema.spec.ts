// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { _void, u32 } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import { catchError } from '@dotli/shared/testing';
import { defineSchema, type Sections } from './defineSchema.js';
import { request } from './request.js';
import { matchFields, matchStringContaining } from './testing/matchers.js';
import { changes, ended, owner, reload, status } from './testing/methodFixtures.js';

describe('defineSchema', () => {
  it('As a schema author, I nest sections and methods and their places follow their order', () => {
    // Given
    const schema = defineSchema({
      version: 2,
      hello: u32,
      sections: {
        resolve: { owner, changes },
        frame: { status, reload, ended },
      },
    });

    // When
    const places = [owner, changes, status, reload].map(schema.addressOf);

    // Then
    expect(places).toEqual([
      { section: 'resolve', method: 'owner', sectionId: 0, methodId: 0 },
      { section: 'resolve', method: 'changes', sectionId: 0, methodId: 1 },
      { section: 'frame', method: 'status', sectionId: 1, methodId: 0 },
      { section: 'frame', method: 'reload', sectionId: 1, methodId: 1 },
    ]);
    expect(schema.sections.resolve.owner).toBe(owner);
    expect(schema.version).toBe(2);
    expect(schema.hello).toBe(u32);
  });

  it('As a schema author, I change my sections record after defining the schema and its places stay as they were', () => {
    // Given
    const sections: Record<string, Record<string, typeof owner | typeof status | typeof reload>> = {
      resolve: { owner },
      frame: { status },
    };
    const schema = defineSchema({ version: 0, hello: _void, sections });

    // When
    delete sections['resolve'];
    sections['later'] = { owner: reload };
    const address = schema.addressOf(owner);
    const refused = catchError(() => schema.addressOf(reload));

    // Then
    expect(address).toEqual({ section: 'resolve', method: 'owner', sectionId: 0, methodId: 0 });
    expect(refused).toEqual(matchErrorContaining("The method is not one of this schema's sections (resolve, frame)"));
    expect(schema.methodAt(0, 0)).toBe(owner);
    expect(schema.methodAt(2, 0)).toBeUndefined();
  });

  it('As a schema author, I define a schema with too many sections or methods, or a version that is not 0 to 255, and am refused', () => {
    // Given
    const fits = { version: 255, hello: _void, sections: createSections(256, 1) };
    const fitsMethods = { version: 0, hello: _void, sections: createSections(1, 256) };

    // When
    const fitsError = catchError(() => defineSchema(fits));
    const fitsMethodsError = catchError(() => defineSchema(fitsMethods));
    const tooManySections = catchError(() =>
      defineSchema({ version: 0, hello: _void, sections: createSections(257, 1) }),
    );
    const tooManyMethods = catchError(() =>
      defineSchema({ version: 0, hello: _void, sections: createSections(1, 257) }),
    );
    const versionOver = catchError(() => defineSchema({ version: 256, hello: _void, sections: {} }));
    const versionUnder = catchError(() => defineSchema({ version: -1, hello: _void, sections: {} }));
    const versionFraction = catchError(() => defineSchema({ version: 1.5, hello: _void, sections: {} }));

    // Then
    expect(fitsError).toBeUndefined();
    expect(fitsMethodsError).toBeUndefined();
    expect(tooManySections).toEqual(matchErrorContaining('at most 256 sections, got 257'));
    expect(tooManyMethods).toEqual(matchErrorContaining('section "section0" has at most 256 methods, got 257'));
    expect(versionOver).toEqual(matchErrorContaining('version must be an integer from 0 to 255, got 256'));
    expect(versionUnder).toEqual(matchErrorContaining('got -1'));
    expect(versionFraction).toEqual(matchErrorContaining('got 1.5'));
  });

  it('As a schema author, I place a method twice and am refused, since the transport finds a method by itself', () => {
    // Given
    const sections = { resolve: { owner }, frame: { reload: owner } };

    // When
    const twice = catchError(() => defineSchema({ version: 0, hello: _void, sections }));

    // Then
    expect(twice).toEqual(matchErrorContaining('frame.reload is the method already at resolve.owner'));
  });
});

function createSections(count: number, methods: number): Sections {
  return Object.fromEntries(
    Array.from({ length: count }, (_, section) => [
      `section${String(section)}`,
      Object.fromEntries(
        Array.from({ length: methods }, (__, method) => [
          `method${String(method)}`,
          request({ request: _void, response: _void }),
        ]),
      ),
    ]),
  );
}

/** Matches an error whose message holds `part`. */
function matchErrorContaining(part: string): Error {
  return matchFields<Error>({ message: matchStringContaining(part) });
}
