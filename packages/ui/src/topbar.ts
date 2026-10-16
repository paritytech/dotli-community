// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Starts the stores the topbar islands render once they mount. Framework-free because it runs at boot.

import { startNetworkStore } from './state/network.js';
import { initNetworkHealth } from './state/network-health.js';
import { initChatPanelState } from './state/chat-panel.js';
import { createBlockingModalCoordinator, type BlockingModalCoordinator } from './blocking-modal-queue.js';
import { initAuthController } from './auth-controller.js';
import { setTopbarPresent } from './state/topbar.js';
import { initTheme } from './theme-controller.js';

export function initTopBar(modalCoordinator: BlockingModalCoordinator = createBlockingModalCoordinator()): void {
  setTopbarPresent();
  initAuthController(modalCoordinator);
  initTheme();
  startNetworkStore();
  initNetworkHealth();
  initChatPanelState();
}
