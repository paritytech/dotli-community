// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { walletPauseStore, type WalletPauseReason } from '../../state/wallet-pause.js';
import { useStore } from '../use-store.js';
import s from './WalletPausedBanner.module.css';

export const WALLET_PAUSED_COPY: Record<WalletPauseReason, { paused: string; resuming: string }> = {
  moved: {
    paused: 'Paused: the test wallet is in use in another tab. Click or type here to use it in this tab.',
    resuming: 'Moving the test wallet to this tab…',
  },
  changed: {
    paused: 'Paused: the test wallet changed in another tab. Click or type here to reload with it.',
    resuming: 'Reloading with the changed test wallet…',
  },
  lost: {
    paused: 'Paused: this tab lost the test wallet. Click or type here to use it again.',
    resuming: 'Moving the test wallet to this tab…',
  },
};

/** Shown while this tab may not sign with the local wallet. Any click or key press here resumes it. */
export function WalletPausedBanner(): JSX.Element {
  const pause = useStore(walletPauseStore);
  return (
    <Show when={pause().reason}>
      {reason => (
        <p class={s['banner']} role="status" data-testid="wallet-paused-banner">
          {WALLET_PAUSED_COPY[reason()][pause().resuming ? 'resuming' : 'paused']}
        </p>
      )}
    </Show>
  );
}
