// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The state the shell's chrome renders. Framework-free because it runs at boot, so each island finds a live store
// whenever it mounts.

import { productPermissions } from '../features/permissions/index.js';
import { topbarState } from '../features/page/index.js';
import { chatPanelState } from '../features/chat/index.js';
import { pageTopbarAutoHide } from '../features/page/index.js';
import { networkHealthState } from '../features/network/index.js';
import { pageTheme } from '../features/settings/index.js';

/**
 * Starts the theme, network health, chat panel, product permission and topbar auto-hide state, once a page. Each lasts the page's life, so their stops
 * go unused.
 * Throws only as one of them does.
 */
export function startShellState(): void {
  topbarState.setPresent();
  pageTheme.startTheme();
  networkHealthState.start();
  chatPanelState.start();
  productPermissions.start();
  pageTopbarAutoHide.start();
}
