// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getErrorName, log } from '@dotli/shared';

import { captureException, type CaptureContext } from './captureException.js';
import { m } from './metrics.js';

type Params = {
  /** The outcome metric the failure is counted under. */
  metric: string;
  /** The error line. */
  message: string;
  /** Defaults to the error's class name, or `unknown` for a thrown non-error. */
  reason?: string;
  /** Defaults to `error`. */
  outcome?: string;
  /** Extra count attributes beside `outcome` and `reason`, from a closed set. */
  attributes?: Record<string, string>;
  /** The logger that writes the line, the root `log` by default, so a child logger keeps its context. */
  logger?: Pick<typeof log, 'error'>;
} & CaptureContext;

/** Report a defect: an issue, an error line and one count of its outcome metric. Never throws. */
export function reportDefect(
  error: unknown,
  { metric, message, reason, outcome = 'error', attributes, logger = log, ...context }: Params,
): void {
  captureException(error, context);
  logger.error(message, error);
  m.count(metric, { ...attributes, outcome, reason: reason ?? getErrorName(error) ?? 'unknown' });
}
