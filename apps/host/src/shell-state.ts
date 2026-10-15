// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The state the shell's chrome renders. Framework-free because it runs at boot, so each island finds a live store
// whenever it mounts.

import { productPermissions } from './runtime/page-permissions.js';
import { setTopbarPresent } from './state/topbar.js';
import { startChatPanelState } from './state/chat-panel.js';
import { startNetworkStore } from './state/network.js';
import { startTopbarAutoHide } from './topbar-autohide.js';
import { startNetworkHealth } from './state/network-health.js';
import { startTheme } from './theme-controller.js';

/** Starts the theme, network, network health, chat panel, product permission and topbar auto-hide state, once a page. */
export function startShellState(): void {
  setTopbarPresent();
  startTheme();
  startNetworkStore();
  startNetworkHealth();
  startChatPanelState();
  productPermissions.start();
  startTopbarAutoHide();
}
