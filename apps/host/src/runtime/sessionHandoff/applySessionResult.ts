// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Writes what the sign-in window sent into this page's copy, so the copy matches the main store and boot picks
// between the paired session and the local wallet from the copy alone.

import type { LocalWalletIdentity, LocalWalletReadResult } from '@dotli/protocol';
import { areBytesEqual, log } from '@dotli/shared';
import type { HostCoreStorage } from '../session/createCoreStorage.js';
import type { SessionResult } from './parseSessionResult.js';

type Params = {
  /** Stores the session in the page's cores. Rejects when it could not be stored. */
  installSession: HostCoreStorage['installSession'];
  /** Reads the page's local wallet. Rejects when it could not be read. */
  readWallet: () => Promise<LocalWalletReadResult>;
  /** Saves the local wallet with a new key. Rejects when it could not be saved. */
  saveWallet: (entropy: Uint8Array, identity: LocalWalletIdentity | null) => Promise<void>;
  /** Boots the page again. */
  reload: () => void;
};

/**
 * Writes the window's result into the page's copy. It answers `applied` once the page's cores hold the session, and
 * `reloading` when a local wallet came with it and the page boots again into local mode. The wallet goes first, so a
 * wallet that cannot be saved leaves the page as it was. Rejects with the failed step as the cause, and never reloads
 * then.
 */
export async function applySessionResult(
  result: SessionResult,
  { installSession, readWallet, saveWallet, reload }: Params,
): Promise<'applied' | 'reloading'> {
  const wallet = result.localWallet;
  if (wallet !== null) {
    try {
      // Saving makes a new key and resets the identity, so a copy that already holds this wallet keeps it untouched.
      if (!isWalletHeld(await readWallet(), wallet.entropy)) {
        await saveWallet(wallet.entropy, wallet.identity);
        log.event('local wallet from the sign-in window saved', { flow: 'wallet' });
      }
    } catch (error) {
      throw new Error('The local wallet from the sign-in window could not be saved', { cause: error });
    }
  }
  if (result.session !== null) {
    try {
      await installSession(result.session.blob, result.session.uiState);
    } catch (error) {
      throw new Error('The session from the sign-in window could not be stored', { cause: error });
    }
    log.event('session from the sign-in window stored', { flow: 'wallet' });
  }
  if (wallet === null) {
    return 'applied';
  }
  // A page that signs in booted without a wallet, even when its copy is the main store the window wrote to.
  reload();
  return 'reloading';
}

function isWalletHeld(stored: LocalWalletReadResult, entropy: Uint8Array): boolean {
  return stored.status === 'ok' && areBytesEqual(stored.entropy, entropy);
}
