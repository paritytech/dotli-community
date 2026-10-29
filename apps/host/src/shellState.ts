// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The state the shell's chrome renders. Framework-free because it runs at boot, so each island finds a live store
// whenever it mounts.

import { productPermissions } from './runtime/pagePermissions.js';
import { topbarState } from './state/topbarState.js';
import { chatPanelState } from './state/chatPanelState.js';
import { networkState } from './state/networkState.js';
import { startTopbarAutoHide } from './topbarAutohide.js';
import { networkHealthState } from './state/networkHealthState.js';
import { startTheme } from './themeController.js';

/** Starts the theme, network, network health, chat panel, product permission and topbar auto-hide state, once a page. */
export function startShellState(): void {
  topbarState.setPresent();
  startTheme();
  networkState.start();
  networkHealthState.start();
  chatPanelState.start();
  productPermissions.start();
  startTopbarAutoHide();
}
