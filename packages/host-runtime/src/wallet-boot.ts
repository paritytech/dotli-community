// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the shared local wallet until the frame answers, then keeps the answer for the page. Its presence is the page's
// wallet mode.

import { SITE_ID } from '@dotli/config';
import { readSharedLocalWallet, type LocalWalletReadResult } from '@dotli/protocol';
import { captureException, m, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, log } from '@dotli/shared';
import { setWalletModeState, type WalletModeState } from './state/wallet-mode.js';

export type LocalWalletBoot = Extract<LocalWalletReadResult, { status: 'ok' }>;

const UNREADABLE = 'Local wallet could not be decrypted and was forgotten';
const UNAVAILABLE = 'Local wallet could not be read, so this page uses Polkadot App';

/** A closed set, so the metric's `reason` tag stays bounded. */
export type LocalWalletFailureReason =
  'read' | 'unreadable' | 'save' | 'forget' | 'boot' | 'activate' | 'reactivate' | 'identity-save';

export function reportLocalWalletFailure(error: unknown, reason: LocalWalletFailureReason): void {
  log.error(`[dot.li wallet] local wallet ${reason} failed:`, error);
  captureException(error, { flow: 'wallet', step: 'local_wallet', tags: { reason } });
  m.count(S.WALLET_LOCAL_ACTIVATE, { outcome: 'error', reason });
}

export interface WalletBootDeps {
  read: () => Promise<LocalWalletReadResult>;
  /** Where the page's wallet mode goes once the read settles it. */
  report: (state: WalletModeState) => void;
}

export interface WalletBoot {
  /** Null boots the pairing host. A failed read cannot tell the mode, so it falls back to Polkadot App. */
  read(): Promise<LocalWalletBoot | null>;
}

export function createWalletBoot({ read, report }: WalletBootDeps): WalletBoot {
  // One read at a time, so a caller that queued behind an answered read takes its answer.
  const reads = createAsyncTaskPool({ poolSize: 1 });
  // Undefined until the frame answers. A read it could not answer tells no mode, so the next caller reads again.
  let answer: LocalWalletBoot | null | undefined;

  const readOnce = async (): Promise<LocalWalletBoot | null> => {
    if (answer !== undefined) {
      return answer;
    }
    let result: LocalWalletReadResult;
    try {
      result = await read();
    } catch (error) {
      reportLocalWalletFailure(error, 'read');
      report({ mode: 'app', failure: UNAVAILABLE });
      return null;
    }
    if (result.status === 'ok') {
      report({ mode: 'local', failure: null });
      answer = result;
      return answer;
    }
    if (result.status === 'unreadable') {
      reportLocalWalletFailure(new Error(UNREADABLE), 'unreadable');
    }
    report({ mode: 'app', failure: result.status === 'unreadable' ? UNREADABLE : null });
    answer = null;
    return answer;
  };

  return {
    read: () => reads.call(readOnce),
  };
}

/** The page's wallet boot, shared by every core and by session state. */
const walletBoot: WalletBoot = createWalletBoot({
  read: () => readSharedLocalWallet(SITE_ID),
  report: setWalletModeState,
});

export function readWalletBoot(): Promise<LocalWalletBoot | null> {
  return walletBoot.read();
}
