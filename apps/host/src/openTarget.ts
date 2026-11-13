// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getLocalTargetPath, type LocalTarget } from './shellRoute.js';
import { pageTopbarAutoHide } from './createTopbarAutoHide.js';
import { pageNotifications } from './pageNotifications.js';
import { authState } from './runtime/state/authState.js';
import { startShieldAutoHide } from './startShieldAutoHide.js';
import type { Shell } from './startShell.js';

/**
 * Opens a local target in the product frame. Rejects with what fails, and halts a frame whose render failed, since the
 * boot's failure screen takes over and the frame must not show the product again on a replacement core.
 */
export async function openTarget(target: LocalTarget, shell: Shell): Promise<void> {
  shell.startup.bridge.setPageProduct({ label: target.host, productId: target.productId });
  pageNotifications().init({ label: target.host });
  try {
    // Local products carry no worker manifest to read the chat flag from, so the debug paths enable chat
    // unconditionally for product testing.
    await shell.productFrame.render({
      mode: 'iframe',
      label: target.host,
      url: target.url,
      productId: target.productId,
      chat: Promise.resolve(true),
    });
  } catch (error) {
    shell.productFrame.halt();
    throw error;
  }
  pageTopbarAutoHide.setContentShown(true);
  // No dotNS name to verify, so the shield is settled as soon as the product shows. The bar folds for the page's life,
  // so the cleanup goes unused.
  startShieldAutoHide({ loggedIn: authState.loggedInStore, arm: pageTopbarAutoHide.arm }).settle();
  history.replaceState(null, '', getLocalTargetPath(target));
}
