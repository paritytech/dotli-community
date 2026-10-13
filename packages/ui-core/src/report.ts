// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How ui reports the failures it recovers from. ui names no metrics package, so whoever mounts or calls it passes
// these in.

/** Where a failure happened, so it can be read and counted per step from its tags alone. */
export interface FailureContext {
  flow: 'ui';
  /** Snake case and low-cardinality, never a label or message. */
  step: string;
  tags: Record<string, string>;
}

/** Raises a failure ui recovered from as an issue. `captureException` fits. */
export type ReportFailure = (error: unknown, context: FailureContext) => void;

/** An expected miss, counted once with `reason`. */
export interface ExpectedContext {
  flow: 'ui';
  step: string;
  reason: string;
}

/**
 * Records a lazy chunk that failed to load ahead of need as a breadcrumb and one count, not an issue. The app binds
 * `reportExpected` with its lazy chunk metric.
 */
export type ReportExpected = (error: unknown, context: ExpectedContext) => void;

/** Everything ui reports through, as the surfaces' context holds it. */
export interface Reporter {
  failure: ReportFailure;
  expected: ReportExpected;
}
