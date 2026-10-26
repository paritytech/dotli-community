// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { createStatusCell } from './createStatusCell.js';

type Status = 'idle' | 'up';

function recordingCell(initial: Status = 'idle') {
  const failures: { error: unknown; value: Status }[] = [];
  const cell = createStatusCell<Status>({
    initial,
    onListenerError: (error, value) => {
      failures.push({ error, value });
    },
  });
  return { cell, failures };
}

describe('createStatusCell', () => {
  it('As a layer owner, I set the status the cell already has and wake nobody', () => {
    // Given
    const { cell } = recordingCell('up');
    const heard: Status[] = [];
    cell.subscribe(value => {
      heard.push(value);
    });

    // When
    cell.set('up');

    // Then
    expect(heard).toEqual([]);
  });
});
