// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Every switch reloads, so the core boots in the new mode instead of being swapped while it runs.

import { SITE_ID } from '@dotli/config';
import { forgetSharedLocalWallet, saveSharedLocalWallet } from '@dotli/protocol';
import { log } from '@dotli/shared';

function reloadPage(): void {
  window.location.reload();
}

export async function switchToLocalWallet(entropy: Uint8Array, reload: () => void = reloadPage): Promise<void> {
  try {
    await saveSharedLocalWallet(SITE_ID, entropy);
  } catch (error) {
    throw new Error('Local wallet could not be saved', { cause: error });
  }
  log.event('local wallet saved', { flow: 'wallet' });
  reload();
}

export async function switchToPolkadotApp(reload: () => void = reloadPage): Promise<void> {
  try {
    await forgetSharedLocalWallet(SITE_ID);
  } catch (error) {
    throw new Error('Local wallet could not be forgotten', { cause: error });
  }
  log.event('local wallet forgotten', { flow: 'wallet' });
  reload();
}
