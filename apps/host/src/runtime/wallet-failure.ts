// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One report for a failed step of signing in, the signed-in flag or the local wallet: an error line, an issue and the
// step's outcome count.

import { captureException, m, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';

/** A tag value from a closed set: a plain `string` does not type, so a tag never takes free text. */
type ClosedSet<Reason extends string> = string extends Reason ? never : Reason;

export interface WalletFailure<Reason extends string> {
  /** What failed, for the log line. */
  what: string;
  /** Groups the issue. */
  step: string;
  /** Tags the issue and the count, so the tag stays bounded. */
  reason: ClosedSet<Reason>;
  /** Counted with the reason, unless the caller counts how its flow ended itself. */
  metric?: string;
}

export function reportWalletFailure<Reason extends string>(
  error: unknown,
  { what, step, reason, metric }: WalletFailure<Reason>,
): void {
  log.error(`[dot.li wallet] ${what} failed:`, error);
  captureException(error, { flow: 'wallet', step, tags: { reason } });
  if (metric !== undefined) {
    m.count(metric, { outcome: 'error', reason });
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
    metric: S.WALLET_LOCAL_ACTIVATE,
  });
}
