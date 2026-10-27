// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { captureException, m, spans as S } from '@dotli/metrics';
import { log, serializeError } from '@dotli/shared';

type Params = {
  error: Error;
  count: typeof m.count;
  /** Whether this loss may be captured. */
  capture: boolean;
};

/**
 * Reports a frame lost after it was ready, once, and captures it when `capture` says so. Returns whether it captured.
 * A tab the SharedWorker let go of while it was frozen finds its port released when it thaws, which is expected, so
 * that loss is counted and left in the trail but never captured.
 */
export function reportFrameLost({ error, count, capture }: Params): boolean {
  const reason = error.name;
  count(S.PROTOCOL_FRAME_LOST, { outcome: 'error', reason });
  if (reason === 'ProtocolPortReleasedError') {
    log.event('protocol frame released', { flow: 'protocol', reason });
    return false;
  }
  m.breadcrumb('protocol frame lost', { reason: serializeError(error) });
  if (capture) {
    captureException(error, { flow: 'protocol', step: 'frame_lost' });
  }
  log.error(`[dot.li protocol] Frame lost: ${serializeError(error)}`);
  return capture;
}
