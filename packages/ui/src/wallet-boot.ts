// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the shared local wallet once per page. Its presence is the page's wallet mode.

import { SITE_ID } from '@dotli/config';
import { readSharedLocalWallet, type LocalWalletReadResult } from '@dotli/protocol';
import { captureException, m, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import { setWalletModeState } from './state/wallet-mode.js';

export type LocalWalletBoot = Extract<LocalWalletReadResult, { status: 'ok' }>;

const UNREADABLE = 'Local wallet could not be decrypted and was forgotten';
const UNAVAILABLE = 'Local wallet could not be read, so this page uses Polkadot App';

let read: Promise<LocalWalletBoot | null> | null = null;

/** A closed set, so the metric's `reason` tag stays bounded. */
export type LocalWalletFailureReason =
  'read' | 'unreadable' | 'save' | 'forget' | 'boot' | 'activate' | 'reactivate' | 'identity-save';

export function reportLocalWalletFailure(error: unknown, reason: LocalWalletFailureReason): void {
  log.error(`[dot.li wallet] local wallet ${reason} failed:`, error);
  captureException(error, { flow: 'wallet', step: 'local_wallet', tags: { reason } });
  m.count(S.WALLET_LOCAL_ACTIVATE, { outcome: 'error', reason });
}

/** Null boots the pairing host. A failed read cannot tell the mode, so it falls back to Polkadot App. */
export function readWalletBoot(): Promise<LocalWalletBoot | null> {
  read ??= readSharedLocalWallet(SITE_ID).then(
    result => {
      if (result.status === 'ok') {
        setWalletModeState({ mode: 'local', failure: null });
        return result;
      }
      if (result.status === 'unreadable') {
        reportLocalWalletFailure(new Error(UNREADABLE), 'unreadable');
        setWalletModeState({ mode: 'app', failure: UNREADABLE });
      }
      return null;
    },
    (error: unknown) => {
      reportLocalWalletFailure(error, 'read');
      setWalletModeState({ mode: 'app', failure: UNAVAILABLE });
      return null;
    },
  );
  return read;
}
