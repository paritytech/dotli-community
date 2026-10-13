// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the bridge asks the user, shows the product frame and reports its chains, answered with the page's dialogs,
// notifications, layout and network panel. Loaded beside the bridge, so the dialogs stay out of the boot chunk.

import type { BridgePorts, HostPrompts, NotificationScheduler, ProductFrameView } from '@dotli/host-runtime';
import { createProductFrameView } from './product-frame-view.js';
import { createHostPrompts } from './host-prompts.js';
import { pageNotifications } from './page-notifications.js';
import { recordBestBlock, recordChainActivity } from './state/network-monitor.js';

export const hostPrompts: HostPrompts = createHostPrompts();

export const scheduledNotifications: NotificationScheduler = {
  schedule: request => pageNotifications().schedule(request),
  cancel: (productId, id) => pageNotifications().cancel(productId, id),
};

export const productFrameView: ProductFrameView = createProductFrameView({
  container: () => document.getElementById('app') ?? document.body,
  body: () => document.body,
});

export const chainActivity: BridgePorts['chainActivity'] = {
  onActivity: recordChainActivity,
  onBestBlock: recordBestBlock,
};
