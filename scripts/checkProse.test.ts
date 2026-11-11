// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findProseIssues } from './checkProse.ts';

describe('findProseIssues', () => {
  it('As a doc author, I get each banned mark in prose reported with its line', () => {
    // Given
    const text = ['Intro line.', 'It runs; then it stops — fast → done.'].join('\n');

    // When
    const issues = findProseIssues(text);

    // Then
    assert.deepEqual(issues, [
      { line: 2, rule: 'an em-dash' },
      { line: 2, rule: 'a semicolon' },
      { line: 2, rule: 'a Unicode arrow' },
    ]);
  });

  it('As a doc author, I can write code and name a banned word without a report', () => {
    // Given
    const text = [
      'Say "network", not "on-chain".',
      'Call `run(); stop();` and see [the guide](a;b.md).',
      '```ts',
      'const a = 1; // on-chain',
      '```',
    ].join('\n');

    // When
    const issues = findProseIssues(text);

    // Then
    assert.deepEqual(issues, []);
  });

  it('As a doc author, I get a banned word used in prose reported', () => {
    // Given
    const text = 'The value is stored on-chain.';

    // When
    const issues = findProseIssues(text);

    // Then
    assert.deepEqual(issues, [{ line: 1, rule: '"on-chain" where "network" or "remote" fits' }]);
  });
});
