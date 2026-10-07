// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Starts the stores the topbar islands render once they mount. Framework-free because it runs at boot.

import { setBlockSource } from './network-monitor.js';
import { createBlockSource } from './block-source.js';
import { startNetworkStore } from './state/network.js';
import { initNetworkHealth, setNetworkHealthWatched } from './state/network-health.js';
import { initChatPanelState } from './state/chat-panel.js';
import { emitPersistedSessionUiState } from './host-callbacks/SessionStore.js';
import { createBlockingModalCoordinator, type BlockingModalCoordinator } from './blocking-modal-queue.js';
import { initAuthController } from './auth-controller.js';
import { setTopbarPresent } from './state/topbar.js';
import { initTheme } from './theme-controller.js';

export function initTopBar(modalCoordinator: BlockingModalCoordinator = createBlockingModalCoordinator()): void {
  setTopbarPresent();
  initAuthController(modalCoordinator);
  initTheme();
  setBlockSource(createBlockSource());
  startNetworkStore();
  initNetworkHealth();
  initChatPanelState();

  // So a reload shows the logged-in badge before any core instance boots.
  scheduleIdle(() => {
    emitPersistedSessionUiState();
  });
}

function scheduleIdle(callback: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => {
      callback();
    });
  } else {
    window.setTimeout(callback, 0);
  }
}

/**
 * Called once a product is on screen. The watch loads a chunk and a client per chain, so it waits for idle and stays
 * out of the load.
 */
export function watchNetworkHealth(): void {
  scheduleIdle(() => {
    setNetworkHealthWatched(true);
  });
}
