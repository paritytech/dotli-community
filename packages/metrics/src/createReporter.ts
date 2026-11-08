// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { log } from '@dotli/shared';

import { captureException, type CaptureContext } from './captureException.js';
import type { SpanHandle } from './createSpanHandle.js';
import { defineCount, type CountMetric } from './defineCount.js';
import { reportDefect } from './reportDefect.js';
import { reportExpected } from './reportExpected.js';

// A report may leave its outcome out only when its metric declares `error`.
type OutcomeParams<Outcome extends string> = 'error' extends Outcome ? { outcome?: Outcome } : { outcome: Outcome };

/** A defect report: the step, the metric it counts under, and the error line. */
export type DefectParams<Outcome extends string> = {
  /** The failing step in stable, low-cardinality snake_case. Part of the issue fingerprint. */
  step: string;
  /** The metric the defect is counted under. */
  metric: CountMetric<Outcome>;
  /** The error line. */
  message: string;
  /** Defaults to the error's class name, or `unknown` for a thrown non-error. */
  reason?: string;
  /** Extra count attributes beside `outcome` and `reason`, from a closed set. */
  attributes?: Record<string, string>;
  /** Searchable tags added to the issue. */
  tags?: Record<string, string>;
  /** Unindexed detail added to the issue. */
  extra?: Record<string, unknown>;
  /** The issue shows inside this span's trace. */
  span?: SpanHandle;
} & OutcomeParams<Outcome>;

/** An expected failure's report: the step, the metric it counts under, and an optional warning. */
export type ExpectedParams<Outcome extends string> = {
  /** The failing step in stable, low-cardinality snake_case. */
  step: string;
  /** The metric the failure is counted under. */
  metric: CountMetric<Outcome>;
  /** Defaults to the error's class name, or `unknown` for a thrown non-error. */
  reason?: string;
  /** Logged as a warning with the error. Leave it out when the failure needs no line in the log. */
  message?: string;
  /** Extra count attributes beside `outcome` and `reason`, from a closed set. */
  attributes?: Record<string, string>;
} & OutcomeParams<Outcome>;

/** One feature's telemetry, every capture, breadcrumb and log line under its flow. */
export type Reporter = ReturnType<typeof createReporter>;

type Params = {
  /** The feature's flow, a stable snake_case name. Part of the issue fingerprint. */
  flow: string;
};

// A report's outcome is checked against its metric where the report is made, so inside only the metric's name is read.
type DefectReport = Omit<Parameters<typeof reportDefect>[1], 'flow' | 'metric' | 'logger'> & {
  metric: Pick<CountMetric, 'name'>;
};
type ExpectedReport = Omit<Parameters<typeof reportExpected>[1], 'flow' | 'metric' | 'logger'> & {
  metric: Pick<CountMetric, 'name'>;
};

/**
 * A listener that threw, so it missed that delivery. Tagged `outcome` (error), `reason` (the error's name) and `owner`
 * (whose listeners, such as `chain_pool.status` or `debug_bus.replay`).
 */
const listenerDeliveryMetric = defineCount<'error'>('listener.delivery');

/**
 * Builds the reporter of the feature whose flow is `flow`, a stable snake_case name.
 *
 * @example
 * const report = createReporter({ flow: 'wallet' });
 * report.defect(error, { step: 'qr_render', metric: qrRenderMetric, message: '[dot.li auth] QR render failed' });
 */
export function createReporter({ flow }: Params) {
  const flowLog = log.createChild({ flow });

  return {
    /** The shared log, with `flow` in every line's attributes. */
    log: flowLog,
    /** Reports a defect: an issue, an error line and one count, outcome `error` unless given. Never throws. */
    defect,
    /** Reports an environment failure: a breadcrumb, an optional warning and one count. Never throws. */
    expected,
    /** Captures a failure as an issue, with no line and no count. Never throws. */
    capture,
    /** For a listener set's `onListenerError`: a throwing listener of `owner` is a defect. Never throws. */
    listener,
  };

  function defect<Outcome extends string>(error: unknown, params: DefectParams<Outcome>): void {
    const { metric, ...rest }: DefectReport = params;
    reportDefect(error, { ...rest, flow, metric: metric.name, logger: flowLog });
  }

  function expected<Outcome extends string>(error: unknown, params: ExpectedParams<Outcome>): void {
    const { metric, ...rest }: ExpectedReport = params;
    reportExpected(error, { ...rest, flow, metric: metric.name, logger: flowLog });
  }

  function capture(error: unknown, context: Omit<CaptureContext, 'flow'>): void {
    captureException(error, { ...context, flow });
  }

  function listener(owner: string): (error: unknown) => void {
    function reportThrownListener(error: unknown): void {
      defect(error, {
        step: 'listener',
        tags: { owner },
        metric: listenerDeliveryMetric,
        message: `[dot.li] A ${owner} listener threw`,
        attributes: { owner },
      });
    }

    return reportThrownListener;
  }
}
