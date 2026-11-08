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
 * Reports a frame lost after it was ready, or a frame held for the shared store that stopped answering, once, and
 * captures it when `capture` says so. Returns whether it captured.
 * A tab the SharedWorker let go of while it was frozen finds its port released when it thaws, which is expected, so
 * that loss is counted and left in the trail but never captured.
 */
export function reportFrameLost({ error, count, capture }: Params): boolean {
  const reason = error.name;
  // Captured, logged and counted by hand, since the count is the injected one.
  count(protocolFrameLostMetric, { outcome: 'error', reason });
  if (reason === 'ProtocolPortReleasedError') {
    report.log.event('protocol frame released', { reason });
    return false;
  }
  m.breadcrumb('protocol frame lost', { reason: serializeError(error) });
  if (capture) {
    report.capture(error, { step: 'frame_lost' });
  }
  log.error(`[dot.li protocol] Frame lost: ${serializeError(error)}`);
  return capture;
}
