// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Writes what the sign-in window sent into this page's copy, so the copy matches the main store and boot picks
// between the paired session and the local wallet from the copy alone.

import type { LocalWalletIdentity, LocalWalletReadResult } from '@dotli/protocol';
import { bytesEqual, log } from '@dotli/shared';
import type { HostCoreStorage } from '../session/core-storage.js';
import type { SessionResult } from './messages.js';

export interface ApplyResultDeps {
  installSession: HostCoreStorage['installSession'];
  readWallet: () => Promise<LocalWalletReadResult>;
  saveWallet: (entropy: Uint8Array, identity: LocalWalletIdentity | null) => Promise<void>;
  reload: () => void;
}

/**
 * Writes the window's result into the page's copy. It answers `applied` once the page's cores hold the session, and
 * `reloading` when a local wallet came with it and the page boots again into local mode. The wallet goes first, so a
 * wallet that cannot be saved leaves the page as it was. Rejects with the failed step as the cause, and never reloads
 * then.
 */
export async function applySessionResult(
  result: SessionResult,
  deps: ApplyResultDeps,
): Promise<'applied' | 'reloading'> {
  const wallet = result.localWallet;
  if (wallet !== null) {
    try {
      // Saving makes a new key and resets the identity, so a copy that already holds this wallet keeps it untouched.
      if (!holds(await deps.readWallet(), wallet.entropy)) {
        await deps.saveWallet(wallet.entropy, wallet.identity);
        log.event('local wallet from the sign-in window saved', { flow: 'wallet' });
      }
    } catch (error) {
      throw new Error('The local wallet from the sign-in window could not be saved', { cause: error });
    }
  }
  if (result.session !== null) {
    try {
      await deps.installSession(result.session.blob, result.session.uiState);
    } catch (error) {
      throw new Error('The session from the sign-in window could not be stored', { cause: error });
    }
    log.event('session from the sign-in window stored', { flow: 'wallet' });
  }
  if (wallet === null) {
    return 'applied';
  }
  // A page that signs in booted without a wallet, even when its copy is the main store the window wrote to.
  deps.reload();
  return 'reloading';
}

function holds(stored: LocalWalletReadResult, entropy: Uint8Array): boolean {
  return stored.status === 'ok' && bytesEqual(stored.entropy, entropy);
}
