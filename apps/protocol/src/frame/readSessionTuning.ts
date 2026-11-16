// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';

const report = createReporter({ flow: 'protocol' });

/** Count. The protocol frame could not read its session tuning, so the light client starts with defaults. */
const protocolSessionTuningMetric = defineCount<'error'>('protocol.session_tuning');

/**
 * The session store a tester tunes the light client through, or `null` where the browser blocks this frame's storage.
 * A tuning knob is never a reason for the light client not to start.
 */
export function readSessionTuning(read: () => Pick<Storage, 'getItem'>): Pick<Storage, 'getItem'> | null {
  try {
    return read();
  } catch (error) {
    report.expected(error, { step: 'session_tuning', metric: protocolSessionTuningMetric });
    return null;
  }
}
