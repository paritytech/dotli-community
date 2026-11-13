// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';
import { getErrorName, log, setErrorName } from '@dotli/shared';
import type { FeedName } from './createFeedKeeper.js';

const report = createReporter({ flow: 'protocol' });

/**
 * A feed the protocol frame ended while it stayed up, so the host reopens it after a backoff. Tagged `outcome` (error),
 * `feed` (shared_auth or telemetry) and `reason` (the error's name, `ProtocolFeedEndedError` for an end without one).
 */
const protocolFeedEndMetric = defineCount<'error'>('protocol.feed_end');

type Params = {
  feed: FeedName;
  /** What the frame ended the feed with, or `null` for an end without an error. */
  error: Error | null;
  /** Whether this end may be captured. */
  capture: boolean;
};

/** Counts and logs an end of `feed` that the frame caused, and captures it when `capture` says so. */
export function reportFeedEnd({ feed, error, capture }: Params): void {
  const ended = error ?? setErrorName(new Error(`The frame ended the ${feed} feed`), 'ProtocolFeedEndedError');
  const message = `[dot.li protocol] The frame ended the ${feed} feed, reopening it:`;
  const attributes = { feed };
  if (capture) {
    report.defect(ended, { step: 'feed_end', tags: { feed }, attributes, metric: protocolFeedEndMetric, message });
    return;
  }
  log.error(message, ended);
  protocolFeedEndMetric.count({ outcome: 'error', ...attributes, reason: getErrorName(ended) ?? 'unknown' });
}
