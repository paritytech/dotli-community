// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { bindLogSink, log, type LogLevel } from './log.js';

describe('bindLogSink', () => {
  it('As a test author, I bind a log sink for one test and unbinding it puts back the sink bound before', () => {
    // Given a sink bound for the file, and one bound over it for a single test
    const outer: LogLevel[] = [];
    const unbindOuter = bindLogSink({ emit: level => outer.push(level) });
    const inner: LogLevel[] = [];
    const unbindInner = bindLogSink({ emit: level => inner.push(level) });

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
