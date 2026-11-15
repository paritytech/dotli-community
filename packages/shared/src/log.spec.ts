// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { catchError } from './testing/catchError.js';
import { bindLogSink, log, type LogLevel } from './log.js';

describe('bindLogSink', () => {
  it('As a test author, I bind a log sink for one test and unbinding it puts back the sink bound before', () => {
    // Given a sink bound for the file, and one bound over it for a single test
    const outer: LogLevel[] = [];
    const unbindOuter = bindLogSink({ emit: ({ level }) => outer.push(level) });
    const inner: LogLevel[] = [];
    const unbindInner = bindLogSink({ emit: ({ level }) => inner.push(level) });

    // When the test's sink is unbound and the page warns again
    log.warn('first');
    unbindInner();
    log.warn('second');
    unbindOuter();

    // Then each warning reached the sink bound at the time
    expect(inner).toEqual(['warn']);
    expect(outer).toEqual(['warn']);
  });
});

describe('log', () => {
  it('As an operator reading a log line, I see its text as written and each other argument as a thrown value reads', () => {
    // Given
    const messages: string[] = [];
    const unbind = bindLogSink({ emit: ({ message }) => messages.push(message) });

    // When
    log.error('Load failed:', new Error('boom'));
    unbind();

    // Then
    expect(messages).toEqual(['Load failed: boom']);
  });

  it('As a page whose log sink throws, I log an error and the call returns', () => {
    // Given
    const unbind = bindLogSink({
      emit: () => {
        throw new Error('sink broke');
      },
    });

    // When
    const thrown = catchError(() => {
      log.error('after');
    });
    unbind();

    // Then
    expect(thrown).toBeUndefined();
  });
});
