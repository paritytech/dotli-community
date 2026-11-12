// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount, m, type CountSink } from '@dotli/metrics';
import { log, serializeError } from '@dotli/shared';

const report = createReporter({ flow: 'protocol' });

/**
 * A protocol frame lost after it was ready, so the host rebuilds it. Tagged `outcome` (error) and `reason` (the error's
 * name, `ProtocolPortReleasedError` for a tab the SharedWorker let go of while it was frozen).
 */
const protocolFrameLostMetric = defineCount<'error'>('protocol.frame_lost');

type Params = {
  error: Error;
  count: CountSink;
  /** Whether this loss may be captured. */
  capture: boolean;
};

/**
 * Whether a frame was lost because the SharedWorker let go of a tab while it was frozen. The tab finds its port released
 * when it thaws, which is expected.
 */
export function isFrameReleased(error: Error): boolean {
  return error.name === 'ProtocolPortReleasedError';
}

/**
 * Reports a frame lost after it was ready, or a frame held for the shared store that stopped answering, once, and
 * captures it when `capture` says so. A released frame is counted and left in the trail but never captured.
 */
export function reportFrameLost({ error, count, capture }: Params): void {
  const reason = error.name;
  // Captured, logged and counted by hand, since the count is the injected one.
  count(protocolFrameLostMetric, { outcome: 'error', reason });
  if (isFrameReleased(error)) {
    report.log.event('protocol frame released', { reason });
    return;
  }
  m.breadcrumb('protocol frame lost', { reason: serializeError(error) });
  if (capture) {
    report.capture(error, { step: 'frame_lost' });
  }
  log.error(`[dot.li protocol] Frame lost: ${serializeError(error)}`);
}
