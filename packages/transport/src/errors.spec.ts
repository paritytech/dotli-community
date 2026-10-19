// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { recordLog } from '@dotli/shared/testing';
import {
  cancelled,
  denied,
  domain,
  err,
  failureReason,
  hostFailure,
  logIssue,
  malformedFrame,
  ok,
  reasonParts,
  unsupported,
} from './errors.js';

describe('issues', () => {
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

describe('reasons', () => {
  it("As a caller, I read a failure's reason back as the name and message of the error that failed", () => {
    // Given
    const errors = [new TypeError('the peer is gone'), new RangeError('expected: a word')];

    // When
    const parts = errors.map(error => reasonParts(failureReason(error)));

    // Then
    expect(parts).toEqual([
      { name: 'TypeError', message: 'the peer is gone' },
      { name: 'RangeError', message: 'expected: a word' },
    ]);
  });

  it('As a caller, I read a reason with no name as the message of a plain error', () => {
    // When
    const parts = reasonParts('the peer is gone');

    // Then
    expect(parts).toEqual({ name: 'Error', message: 'the peer is gone' });
  });
});

describe('result', () => {
  it('As a caller, I tell ok from err by its success, as scale-ts reads a Result', () => {
    // Given
    const good = ok(7);
    const bad = err('nope');

    // When
    const empty = ok();

    // Then
    expect(good).toEqual({ success: true, value: 7 });
    expect(bad).toEqual({ success: false, value: 'nope' });
    expect(empty).toEqual({ success: true, value: undefined });
  });

  it('As a handler, I build each CallError variant with its constructor', () => {
    // Given
    const reason = 'bad bytes';

    // When
    const all = [domain(3), denied(), unsupported(), malformedFrame(reason), hostFailure(reason), cancelled()];

    // Then
    expect(all).toEqual([
      { tag: 'Domain', value: 3 },
      { tag: 'Denied', value: undefined },
      { tag: 'Unsupported', value: undefined },
      { tag: 'MalformedFrame', value: { reason } },
      { tag: 'HostFailure', value: { reason } },
      { tag: 'Cancelled', value: undefined },
    ]);
  });

  it('As a handler, I fail a call with an error as a handler that throws it would, so the caller reads its name', () => {
    // Given
    const thrown = new TypeError('bad label');
    const long = new Error('x'.repeat(600));

    // When
    const failures = [hostFailure(thrown), hostFailure(long)];

    // Then
    expect(failures).toEqual([
      { tag: 'HostFailure', value: { reason: 'TypeError: bad label' } },
      { tag: 'HostFailure', value: { reason: `Error: ${'x'.repeat(493)}` } },
    ]);
  });
});
