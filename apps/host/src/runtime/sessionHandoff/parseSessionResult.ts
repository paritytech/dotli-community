// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sign-in window's result as a page reads it. The parser accepts exactly the documented shape and returns null for
 * anything else.
 */

import { isLocalWalletEntropy, isLocalWalletIdentity, type LocalWalletIdentity } from '@dotli/protocol';
import { isRecord } from '@dotli/shared';

/** What the sign-in window hands a page: the paired session and the local wallet, each null when it sends none. */
export type SessionResult = {
  session: { blob: string; uiState: string | null } | null;
  localWallet: { entropy: Uint8Array; identity: LocalWalletIdentity | null } | null;
};

/** The window's result as a page reads it, or null when `value` is not one. */
export function parseSessionResult(value: unknown): SessionResult | null {
  if (!isRecord(value) || !isSession(value['session']) || !isLocalWallet(value['localWallet'])) {
    return null;
  }
  return { session: value['session'], localWallet: value['localWallet'] };
}

function isSession(value: unknown): value is SessionResult['session'] {
  if (value === null) {
    return true;
  }
  return (
    isRecord(value) &&
    typeof value['blob'] === 'string' &&
    value['blob'] !== '' &&
    (value['uiState'] === null || typeof value['uiState'] === 'string')
  );
}

function isLocalWallet(value: unknown): value is SessionResult['localWallet'] {
  if (value === null) {
    return true;
  }
  if (!isRecord(value) || !(value['entropy'] instanceof Uint8Array) || !isLocalWalletEntropy(value['entropy'])) {
    return false;
  }
  return value['identity'] === null || isLocalWalletIdentity(value['identity']);
}
