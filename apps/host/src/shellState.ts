// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The state the shell's chrome renders. Framework-free because it runs at boot, so each island finds a live store
// whenever it mounts.

import { productPermissions } from './runtime/pagePermissions.js';
import { setTopbarPresent } from './state/topbar.js';
import { startChatPanelState } from './state/chatPanel.js';
import { startNetworkStore } from './state/network.js';
import { startTopbarAutoHide } from './topbarAutohide.js';
import { startNetworkHealth } from './state/networkHealth.js';
import { startTheme } from './themeController.js';

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
