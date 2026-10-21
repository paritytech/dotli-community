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

const RESOLVE_BUDGET_KEY = 'dotli:resolve-budget-ms';

/** A tester's cap on each request's sync budget, so a resolver timeout shows in seconds rather than minutes. */
export function resolveBudgetCapMs(session: Pick<Storage, 'getItem'> | null): number | undefined {
  const cap = Number(session?.getItem(RESOLVE_BUDGET_KEY) ?? '');
  return Number.isInteger(cap) && cap > 0 ? cap : undefined;
}
