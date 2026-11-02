// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isShallowEqual } from './isShallowEqual.js';

type Case = {
  label: string;
  left: unknown;
  right: unknown;
};

const nested = { x: 1 };
const item = { id: 1 };

describe('isShallowEqual', () => {
  it.each<Case>([
    { label: 'objects with the same keys and identical values', left: { a: 1, b: nested }, right: { a: 1, b: nested } },
    { label: 'objects holding NaN under the same key', left: { a: Number.NaN }, right: { a: Number.NaN } },
    { label: 'one number with itself', left: 1, right: 1 },
    { label: 'null with null', left: null, right: null },
    { label: 'arrays with identical items', left: [item, 2], right: [item, 2] },
  ])('As a store, I compare $label and find them equal', ({ left, right }) => {
    // Given the two values of the row

    // When
    const equal = isShallowEqual(left, right);

    // Then
    expect(equal).toBe(true);
  });

  it.each<Case>([
    { label: 'objects with a changed value', left: { a: 1 }, right: { a: 2 } },
    { label: 'objects where one has an extra key', left: { a: 1 }, right: { a: 1, b: undefined } },
    { label: 'objects holding nested copies', left: { a: { x: 1 } }, right: { a: { x: 1 } } },
    { label: 'a number with its string', left: 1, right: '1' },
    { label: 'null with an object', left: null, right: {} },
    { label: 'arrays of different lengths', left: [item], right: [item, 2] },
  ])('As a store, I compare $label and find them different', ({ left, right }) => {
    // Given the two values of the row

    // When
    const equal = isShallowEqual(left, right);

    // Then
    expect(equal).toBe(false);
  });
});
