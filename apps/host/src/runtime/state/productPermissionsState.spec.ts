// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  getRead,
  isUnreadable,
  type PermissionsRead,
  type ProductPermissionsState,
} from './productPermissionsState.js';

const LABEL = 'myapp';

describe('product permissions views', () => {
  const READ = { status: 'read', label: LABEL, statuses: ['granted', 'ask'] } satisfies ProductPermissionsState;

  it.each<{ story: string; state: ProductPermissionsState; expected: PermissionsRead | undefined }>([
    { story: 'nothing on show', state: { status: 'none' }, expected: undefined },
    { story: 'a read under way', state: { status: 'reading', label: LABEL }, expected: undefined },
    { story: 'a failed read', state: { status: 'failed', label: LABEL }, expected: undefined },
    { story: 'statuses read', state: READ, expected: READ },
  ])(
    'As the permissions panel, I ask for the read with $story and get the statuses only once read',
    ({ state, expected }) => {
      // Given the row's store state, from the table

      // When
      const read = getRead(state);

      // Then
      expect(read).toBe(expected);
    },
  );

  it.each<{ story: string; state: ProductPermissionsState; expected: boolean }>([
    { story: "the product's read failed", state: { status: 'failed', label: LABEL }, expected: true },
    { story: "another product's read failed", state: { status: 'failed', label: 'other' }, expected: false },
    { story: 'its read is under way', state: { status: 'reading', label: LABEL }, expected: false },
    { story: 'its statuses are read', state: READ, expected: false },
    { story: 'nothing is on show', state: { status: 'none' }, expected: false },
  ])(
    'As the permissions panel, I ask whether the product is unreadable when $story and am told $expected',
    ({ state, expected }) => {
      // Given the row's store state, from the table

      // When
      const unreadable = isUnreadable(state, LABEL);

      // Then
      expect(unreadable).toBe(expected);
    },
  );
});
