// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Starts the stores the topbar islands render once they mount. Framework-free because it runs at boot.

import { startNetworkStore } from './state/network.js';
import { initNetworkHealth } from './state/network-health.js';
import { initChatPanelState } from './state/chat-panel.js';
import { emitPersistedSessionUiState } from './host-callbacks/SessionStore.js';
import { createBlockingModalCoordinator, type BlockingModalCoordinator } from './blocking-modal-queue.js';
import { initAuthController } from './auth-controller.js';
import { setTopbarPresent } from './state/topbar.js';
import { initTheme } from './theme-controller.js';
import { log } from '@dotli/shared';
import { dispatchAuthState } from './host-callbacks/AuthState.js';

export function initTopBar(modalCoordinator: BlockingModalCoordinator = createBlockingModalCoordinator()): void {
  setTopbarPresent();
  initAuthController(modalCoordinator);
  initTheme();
  startNetworkStore();
  initNetworkHealth();
  initChatPanelState();

  // At once, not on idle: the auth button spins until this read ends, and a busy boot can starve an idle callback.
  void emitPersistedSessionUiState().catch((error: unknown) => {
    log.warn('[dot.li] saved wallet restoration failed:', error);
    dispatchAuthState({
      tag: 'WalletUnavailable',
      reason: error instanceof Error ? error.message : String(error),
    });
  });
}
