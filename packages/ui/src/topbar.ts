// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Top bar boot wiring
//
// Starts what the topbar needs from boot on: the auth controller, the block
// source and network store, the product chat, the theme preference and the
// idle session rehydrate. Every popover, and the mobile "more"
// flyout, is a shell island (components/shell/) that renders these stores
// when it mounts. No framework here: this runs on the startup path.
//
import { log } from '@dotli/shared';
import { setBlockSource } from './network-monitor.js';
import { createBlockSource } from './block-source.js';
import { startNetworkStore } from './state/network.js';
import { initNetworkHealth, setNetworkHealthWatched } from './state/network-health.js';
import { initChatPanelState } from './state/chat-panel.js';
import { emitPersistedSessionUiState } from './host-callbacks/SessionStore.js';
import { dispatchAuthState } from './host-callbacks/AuthState.js';
import { createBlockingModalCoordinator, type BlockingModalCoordinator } from './blocking-modal-queue.js';
import { initAuthController } from './auth-controller.js';
import { getTopbarState, recordChainsButtonVisible, setTopbarPresent } from './state/topbar.js';
import { initTheme } from './theme-controller.js';

export function initTopBar(modalCoordinator: BlockingModalCoordinator = createBlockingModalCoordinator()): void {
  setTopbarPresent();
  // The login and auth-state listeners, from boot on: the auth islands
  // mount later and render what the controller has kept.
  initAuthController(modalCoordinator);

  // Theme preference (the toggle itself is components/shell/ThemeToggle.tsx)
  initTheme();

  // The chains the network popover (an island) watches, the store it
  // renders, and the health the status capsule shows, from boot on.
  setBlockSource(createBlockSource());
  startNetworkStore();
  initNetworkHealth();

  // The product chat's state: its button and docked panel are islands.
  initChatPanelState();

  // Rehydrate the persisted same-origin session on idle so a reload shows
  // the logged-in badge before any core instance boots.
  scheduleIdle(() => {
    void emitPersistedSessionUiState().catch((error: unknown) => {
      log.warn('[dot.li] Persisted wallet restoration failed:', error);
      dispatchAuthState({
        tag: 'WalletUnavailable',
        reason: error instanceof Error ? error.message : String(error),
      });
    });
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
 * Reveal the network button. The host calls this once a product is on
 * screen, so the icon appears with the app rather than during the load.
 * Writes the store the chains island renders, and starts or stops the
 * health watch the status capsule reads.
 */
export function setChainsButtonVisible(visible: boolean): void {
  recordChainsButtonVisible(visible);
  if (!visible) {
    setNetworkHealthWatched(false);
    return;
  }
  // The watch loads the block-watch chunk and a client per chain, so it waits
  // until the product has rendered and the page is idle.
  scheduleIdle(() => {
    if (getTopbarState().chainsButtonVisible) {
      setNetworkHealthWatched(true);
    }
  });
}
