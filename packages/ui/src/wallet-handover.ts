// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One tab of the browser profile signs with the local wallet. Booting a local core takes the wallet from whichever tab
// has it. That tab stops signing, shows a paused banner, and takes the wallet back on the user's next interaction,
// never from background activity, so two tabs cannot bounce it between them. Taking it back reloads, and the reload's
// core asks for the wallet again.

import { SITE_ID } from '@dotli/config';
import {
  requestLocalWalletOwner,
  subscribeLocalWalletChanged,
  subscribeLocalWalletOwnerRevoked,
} from '@dotli/protocol';
import { log } from '@dotli/shared';
import { ensureOverlays } from './overlays/load.js';
import {
  markLocalWalletResuming,
  pauseLocalWallet,
  walletPauseStore,
  type WalletPauseReason,
} from './state/wallet-pause.js';

const PAUSED = 'The test wallet is paused in this tab. Reload to use it here.';

// This page's lease while it may sign. A revocation clears it before the page releases the lock.
let lease: Promise<string> | null = null;
let revocationBound = false;

/**
 * Call `resume` once on the next user interaction with this tab: a pointer or key press in the shell, or focus moving
 * into the app frame (the frame is cross-origin, so its own events never reach this document). Focus still inside the
 * app frame would never move into it again, so a click there would go unnoticed; focus goes back to the shell first.
 */
export function onNextInteraction(resume: () => void, win: Window = window): () => void {
  let done = false;
  const focused = win.document.activeElement;
  if (focused instanceof HTMLIFrameElement) {
    focused.blur();
  }
  const onBlur = (): void => {
    setTimeout(() => {
      if (win.document.activeElement?.tagName === 'IFRAME') {
        fire();
      }
    }, 0);
  };
  const stop = (): void => {
    win.removeEventListener('pointerdown', fire, true);
    win.removeEventListener('keydown', fire, true);
    win.removeEventListener('blur', onBlur);
  };
  function fire(): void {
    if (done) {
      return;
    }
    done = true;
    stop();
    resume();
  }
  win.addEventListener('pointerdown', fire, true);
  win.addEventListener('keydown', fire, true);
  win.addEventListener('blur', onBlur);
  return stop;
}

/** Page core subscribers dispose every core synchronously when this sets the pause. */
function pause(reason: WalletPauseReason): void {
  if (!pauseLocalWallet(reason)) {
    return;
  }
  log.event('local wallet paused', { flow: 'wallet', reason });
  void ensureOverlays();
  onNextInteraction(() => {
    markLocalWalletResuming();
    window.location.reload();
  });
}

function onRevoked(token: string | undefined): void {
  if (lease === null) {
    return;
  }
  lease = null;
  pause(token === undefined ? 'lost' : 'moved');
  // Released only after the pause stopped the signer, so the two tabs never sign at once.
  if (token !== undefined) {
    requestLocalWalletOwner(SITE_ID, { action: 'release', lease: token }).catch((error: unknown) => {
      // The other tab then gets the busy error, and the lock goes with this page.
      log.warn('[dot.li wallet] local wallet lease release failed:', error);
    });
  }
}

/** Resolves once this page is the one tab signing with the local wallet. */
export async function acquireLocalWalletOwner(): Promise<void> {
  if (walletPauseStore.get().reason !== null) {
    throw new Error(PAUSED);
  }
  if (!revocationBound) {
    revocationBound = true;
    subscribeLocalWalletOwnerRevoked(onRevoked);
  }
  lease ??= requestLocalWalletOwner(SITE_ID, { action: 'acquire' }).then(token => {
    if (token === undefined) {
      throw new Error('The protocol frame granted no local wallet lease');
    }
    return token;
  });
  const pending = lease;
  try {
    await pending;
  } catch (error) {
    if (lease === pending) {
      lease = null;
    }
    throw error;
  }
  if (lease !== pending) {
    throw new Error(PAUSED);
  }
}

/**
 * A save or forget in a sibling tab makes this page's wallet mode or entropy stale, so it pauses until the user reloads.
 * A held lease stays until the reloaded sibling asks for it.
 */
export function watchLocalWalletChanges(): void {
  subscribeLocalWalletChanged(() => {
    pause('changed');
  });
}

/** Tests only. */
export function resetWalletHandoverForTests(): void {
  lease = null;
  revocationBound = false;
}
