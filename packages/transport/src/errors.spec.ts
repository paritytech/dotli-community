// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { logIssue } from './errors.js';
import { errorLog } from './testing/rig.js';

describe('issues', () => {
  it("As an owner with no issue hook, I read a failed post with its call's names, or without them when it had no call", () => {
    // Given
    const errors = errorLog();
    const error = new Error('the peer window is gone');

    // When
    logIssue({ kind: 'post_failed', error, call: { trait: 'notes', method: 'read' } });
    logIssue({ kind: 'post_failed', error });

    // Then
    expect(errors).toEqual([
      '[transport] A notes.read message could not be posted, Error: the peer window is gone',
      '[transport] A message could not be posted, Error: the peer window is gone',
    ]);
  });
});
