// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the page gives the debug panel. Loaded only with the panel, so the diagnostics, the wallet switch and the
// recovery phrase check stay out of the boot chunk.

import { getBackend } from '@dotli/config';
import { loadFetch } from '@dotli/content';
import { setDockInset } from './product-frame-layout.js';
import { getTopbarState } from './state/topbar.js';
import { closeDebugMode } from './settings-actions.js';
import {
  authStore,
  pageDiagnostics,
  phraseToEntropy,
  productStore,
  walletModeStore,
  walletSwitch,
} from '@dotli/host-runtime';
import type { DebugPanelParts } from './debug-panel.js';

export const debugPanelParts: DebugPanelParts = {
  product: productStore,
  auth: authStore,
  walletMode: walletModeStore,
  walletSwitch,
  phraseToEntropy,
  diagnostics: pageDiagnostics,
  readArchive: async (cid, transport) => (await loadFetch()).readArchiveFiles(cid, transport),
  viaGateway: () => getBackend() === 'rpc-gateway',
  topbarPresent: () => getTopbarState().present,
  setDockInset,
  leaveDebugMode: closeDebugMode,
};
