// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount, type CountMetric } from '@dotli/metrics';

/**
 * Count. A write of the signed-in flag that failed, so other subdomains read the old flag. Tagged `outcome` (`error`)
 * and `reason`, the write (`set`, `clear`, or `renew` for a renew of a flag that is still set).
 */
const sessionFlagWriteMetric = defineCount<'error'>('session.flag_write');

/** A write of the signed-in flag. */
export type FlagWrite = 'set' | 'clear' | 'renew';

/** What a failed write of the flag is reported under. */
type FlagWriteReport = {
  step: string;
  reason: FlagWrite;
  metric: CountMetric<'error'>;
};

/** The step, reason and metric a failed write of the flag is reported under, whichever store holds the flag. */
export function getFlagWriteReport(write: FlagWrite): FlagWriteReport {
  return { step: `presence_${write}`, reason: write, metric: sessionFlagWriteMetric };
}
