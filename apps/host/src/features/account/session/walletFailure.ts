// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One report for a failed step of signing in, the signed-in flag or the local wallet: an error line, an issue and the
// step's outcome count.

import { createReporter, defineCount, type CountMetric } from '@dotli/metrics';
import { log } from '@dotli/shared';

const report = createReporter({ flow: 'wallet' });

/** Local wallet boot, activation and identity steps. Tagged `outcome` and, on failure, `reason`. */
export const walletLocalActivateMetric = defineCount<'error' | 'ok'>('wallet.local_activate');

/** A tag value from a closed set: a plain `string` does not type, so a tag never takes free text. */
type ClosedSet<Reason extends string> = string extends Reason ? never : Reason;

export type WalletFailure<Reason extends string> = {
  /** What failed, for the log line. */
  what: string;
  /** Groups the issue. */
  step: string;
  /** Tags the issue and the count, so the tag stays bounded. */
  reason: ClosedSet<Reason>;
  /** Counted with the reason, unless the caller counts how its flow ended itself. */
  metric?: CountMetric<'error'>;
};

export function reportWalletFailure<Reason extends string>(
  error: unknown,
  { what, step, reason, metric }: WalletFailure<Reason>,
): void {
  // By hand, since the count is optional.
  log.error(`[dot.li wallet] ${what} failed:`, error);
  report.capture(error, { step, tags: { reason } });
  if (metric !== undefined) {
    metric.count({ outcome: 'error', reason });
  }
}

export type LocalWalletFailureReason =
  'read' | 'unreadable' | 'save' | 'forget' | 'boot' | 'activate' | 'reactivate' | 'identity-save' | 'phrase-load';

/** A failed step of the local wallet, from its boot and switch on a page to its import in the sign-in window. */
export function reportLocalWalletFailure(error: unknown, reason: LocalWalletFailureReason): void {
  reportWalletFailure(error, {
    what: `local wallet ${reason}`,
    step: 'local_wallet',
    reason,
    metric: walletLocalActivateMetric,
  });
}
