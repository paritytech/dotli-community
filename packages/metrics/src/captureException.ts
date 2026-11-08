// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Captures forward to one bound sink, so tests record them by binding their own instead of mocking this package.
// Imports no SDK, so a module that only reports failures does not pull it in.

import type { SpanHandle } from './createSpanHandle.js';

export type CaptureContext = {
  /**
   * The flow the failure belongs to, a stable snake_case name its feature's reporter gives. Part of the issue
   * fingerprint.
   */
  flow: string;
  /**
   * The failing step in snake_case (`manifest_read`). Part of the issue fingerprint, so keep it
   * stable and low-cardinality: never a label, CID or message.
   */
  step: string;
  /** Searchable tags added to the event. */
  tags?: Record<string, string>;
  /** Unindexed detail added to the event. */
  extra?: Record<string, unknown>;
  /** The error shows inside this span's trace. */
  span?: SpanHandle;
};

/** Where captured failures go. A sink is bound at startup, until then captures are dropped. */
export type CaptureSink = {
  /** Reports a failure as an issue. A throw never reaches the code that reported the failure. */
  exception: (error: unknown, context: CaptureContext) => void;
  /** Records an expected failure as a breadcrumb. A throw never reaches the code that reported the failure. */
  expected: (error: unknown, context: Pick<CaptureContext, 'flow' | 'step'>) => void;
};

// Before `initSentry` Sentry has no client and drops events, so the unbound sink drops them too.
const DROPPING_SINK: CaptureSink = {
  exception: () => undefined,
  expected: () => undefined,
};

let sink: CaptureSink = DROPPING_SINK;

/**
 * Report a caught exception as a failure of one flow step. Never throws.
 * Flow and step join the fingerprint because errors rebuilt from another realm share one receiving stack.
 */
export function captureException(error: unknown, context: CaptureContext): void {
  deliver(() => {
    sink.exception(error, context);
  });
}

/**
 * Record an expected, handled failure as a breadcrumb rather than an issue, to explain any later event. Never throws.
 */
export function recordExpected(error: unknown, context: Pick<CaptureContext, 'flow' | 'step'>): void {
  deliver(() => {
    sink.expected(error, context);
  });
}

/**
 * Send captures to `next`. Returns a function that restores the sink bound before, so unbind in reverse order.
 *
 * @example
 * const restore = bindCaptureSink({ exception: report, expected: () => undefined });
 * restore();
 */
export function bindCaptureSink(next: CaptureSink): () => void {
  const previous = sink;
  sink = next;

  function restore(): void {
    sink = previous;
  }

  return restore;
}

// Reports run inside catch blocks, so a throwing sink would skip the caller's own recovery. The reporting pipeline is
// what failed, so the console is the one place left to say so.
function deliver(send: () => void): void {
  try {
    send();
  } catch (error) {
    // eslint-disable-next-line no-console -- the reporting pipeline failed, so it cannot report itself
    console.error('[dot.li metrics] capture sink threw', error);
  }
}
