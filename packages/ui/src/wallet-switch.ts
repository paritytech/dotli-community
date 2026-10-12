// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Every switch reloads, so the core boots in the new mode instead of being swapped while it runs.

import { SITE_ID } from '@dotli/config';
import { forgetSharedLocalWallet, saveSharedLocalWallet } from '@dotli/protocol';
import { log } from '@dotli/shared';
import { revokeReceivingOnLogout } from './receiving.js';

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
  // Forgetting the local wallet logs its account out; its retained receiving registrations go first.
  try {
    await revokeReceivingOnLogout();
  } catch (error) {
    throw new Error('Background receiving could not be revoked; the local wallet was kept', { cause: error });
  }
  try {
    await forgetSharedLocalWallet(SITE_ID);
  } catch (error) {
    throw new Error('Local wallet could not be forgotten', { cause: error });
  }
  log.event('local wallet forgotten', { flow: 'wallet' });
  reload();
}
