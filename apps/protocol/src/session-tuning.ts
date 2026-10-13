// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { reportExpected, spans as S } from '@dotli/metrics';

/**
 * The session store a tester tunes the light client through, or `null` where the browser blocks this frame's storage.
 * A tuning knob is never a reason for the light client not to start.
 */
export function readSessionTuning(read: () => Pick<Storage, 'getItem'>): Pick<Storage, 'getItem'> | null {
  try {
    return read();
  } catch (err) {
    reportExpected(err, { flow: 'protocol', step: 'session_tuning', metric: S.PROTOCOL_SESSION_TUNING });
    return null;
  }
}
