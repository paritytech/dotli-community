// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Captures forward to one bound sink, so tests record them by binding their own instead of mocking this package.
// Sentry-free, so a module that only reports failures does not pull in the SDK.

import { errorName, log } from '@dotli/shared';
import { m, type MetricOutcome, type SpanHandle } from './metrics.js';
import * as S from './spans.js';

/** The user flow an event belongs to, so failures can be read and counted per flow from tags alone. */
export type Flow =
  'boot' | 'resolve' | 'content' | 'protocol' | 'wallet' | 'storage' | 'notifications' | 'pwa' | 'ui' | 'chat';

export interface CaptureContext {
  flow: Flow;
  /**
   * The failing step in snake_case (`manifest_read`). Part of the issue fingerprint, so keep it
   * stable and low-cardinality: never a label, CID or message.
   */
  step: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  /** The error shows inside this span's trace. */
  span?: SpanHandle;
}

/** Where captured failures go. `initSentry` binds the Sentry sink. */
export interface CaptureSink {
  exception: (err: unknown, ctx: CaptureContext) => void;
  expected: (err: unknown, ctx: Pick<CaptureContext, 'flow' | 'step'>) => void;
}

// Before `initSentry` Sentry has no client and drops events, so the unbound sink drops them too.
const DROP: CaptureSink = {
  exception: () => undefined,
  expected: () => undefined,
};

let sink: CaptureSink = DROP;

/** Send captures to `next`. Returns a function that restores the sink bound before, so unbind in reverse order. */
export function bindCaptureSink(next: CaptureSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

// Reports run inside catch blocks, so a throwing sink would skip the caller's own recovery. The reporting pipeline is
// what failed, so the console is the one place left to say so.
function deliver(send: () => void): void {
  try {
    send();
  } catch (err) {
    // eslint-disable-next-line no-console -- the reporting pipeline failed, so it cannot report itself
    console.error('[dot.li metrics] capture sink threw', err);
  }
}

/**
 * Report a caught exception as a failure of one flow step.
 * Flow and step join the fingerprint because errors rebuilt from another realm share one receiving stack.
 */
export function captureException(err: unknown, ctx: CaptureContext): void {
  deliver(() => {
    sink.exception(err, ctx);
  });
}

/** Record an expected, handled failure as a breadcrumb rather than an issue, to explain any later event. */
export function recordExpected(err: unknown, ctx: Pick<CaptureContext, 'flow' | 'step'>): void {
  deliver(() => {
    sink.expected(err, ctx);
  });
}

export interface ExpectedReport extends Pick<CaptureContext, 'flow' | 'step'> {
  /** The outcome metric the failure is counted under. */
  metric: string;
  /** Defaults to the error's class name, or `unknown` for a thrown non-error. */
  reason?: string;
  outcome?: MetricOutcome;
  /** Logged as a warning with the error. Leave it out when the failure needs no line in the log. */
  message?: string;
}

/** Report an environment failure: an optional warning, its breadcrumb and one count of its outcome metric. */
export function reportExpected(
  err: unknown,
  { flow, step, metric, reason, outcome = 'error', message }: ExpectedReport,
): void {
  if (message !== undefined) {
    log.warn(message, err);
  }
  recordExpected(err, { flow, step });
  m.count(metric, { outcome, reason: reason ?? errorName(err) ?? 'unknown' });
}

/**
 * For a listener set's `onListenerError`: a throwing listener is a defect in its subscriber, so it is captured, logged
 * and counted under `owner`, while the set's other listeners still hear the value.
 */
export function reportListener(flow: Flow, owner: string): (error: unknown) => void {
  return error => {
    captureException(error, { flow, step: 'listener', tags: { owner } });
    log.error(`[dot.li] A ${owner} listener threw`, error);
    m.count(S.LISTENER_DELIVERY, { outcome: 'error', reason: errorName(error) ?? 'unknown', owner });
  };
}
