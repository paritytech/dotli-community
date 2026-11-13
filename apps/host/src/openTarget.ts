// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { DEBUG } from '@dotli/config';
import { createReporter } from '@dotli/metrics';
import { debugBus } from '@dotli/truapi-debug';
import { bootTracker } from './createBootTracker.js';
import { getLocalTargetPath, type LocalTarget } from './shellRoute.js';
import { pageTopbarAutoHide } from './createTopbarAutoHide.js';
import { pageNotifications } from './pageNotifications.js';
import { PAGE_START } from './pageStart.js';
import { authState } from './runtime/state/authState.js';
import { startShieldAutoHide } from './startShieldAutoHide.js';
import type { Shell } from './startShell.js';

const bootReport = createReporter({ flow: 'boot' });

/**
 * Opens a local target in the product frame. Rejects with what fails, and halts a frame whose render failed, since the
 * boot's failure screen takes over and the frame must not show the product again on a replacement core.
 */
export async function openTarget(target: LocalTarget, shell: Shell): Promise<void> {
  // Only debug builds read a localhost route, so the compile-time flag drops its branches from release bundles.
  const proxied = DEBUG && target.kind === 'localhost';
  bootTracker.setStep(proxied ? 'localhost_render' : 'preview_render');
  bootReport.log.event(proxied ? 'Route: localhost proxy' : 'Route: preview', { host: target.host });
  shell.startup.bridge.setPageProduct({ label: target.host, productId: target.productId });
  pageNotifications().init();
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
  performance.mark('dotli:main:end');
  if (proxied) {
    debugBus.emit({
      layer: 'boot',
      event: 'ready',
      flowId: shell.flowId,
      timestamp: Date.now(),
      payload: { label: null, totalMs: performance.now() - PAGE_START, path: 'localhost' },
    });
  }
}
