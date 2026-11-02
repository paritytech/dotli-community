// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { recordLog } from '@dotli/shared/testing';
import { logIssue } from './logIssue.js';

describe('logIssue', () => {
  it("As an owner with no issue hook, I read a failed post with its call's names, or without them when it had no call", () => {
    // Given
    const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
    const error = new Error('the peer window is gone');

    // When
    logIssue({ kind: 'post_failed', error, call: { section: 'notes', method: 'read' } });
    logIssue({ kind: 'post_failed', error });

    // Then
    expect(errors.map(line => line.message)).toEqual([
      '[transport] A notes.read message could not be posted, Error: the peer window is gone',
      '[transport] A message could not be posted, Error: the peer window is gone',
    ]);
  });
});
