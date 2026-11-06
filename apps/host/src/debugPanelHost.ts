// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page as the debug panel reads it. Loaded only with the panel, so the diagnostics and the archive reader stay out
// of the boot chunk.

import { getBackend } from '@dotli/config';
import { readArchiveFiles } from '@dotli/content';
import { blockCache } from '@dotli/storage';
import type { DebugPanelHost } from '@dotli/truapi-debug-ui';
import { hostBitswapClient } from './runtime/hostCallbacks/createHostBitswapClient.js';
import { createArchiveTransport } from './createArchiveTransport.js';
import { productFrameLayout, type ProductFrameLayout } from './createProductFrameLayout.js';
import { topbarState } from './state/topbarState.js';
import { closeDebugMode } from './debugMode.js';
import { authControl } from './runtime/createAuthController.js';
import { authState } from './runtime/state/authState.js';
import { pageDiagnostics } from './runtime/createPageDiagnostics.js';
import { productState } from './runtime/state/productState.js';
import { walletModeState } from './runtime/state/walletModeState.js';

type Params = {
  /** The frame layout the panel's dock takes its room from. */
  layout: Pick<ProductFrameLayout, 'setDockInset'>;
};

/** Builds the page as the debug panel reads it, with the panel's dock reserved on `layout`. */
export function createDebugPanelHost({ layout }: Params): DebugPanelHost {
  return {
    product: productState.store,
    auth: authState.store,
    walletMode: walletModeState.store,
    walletSwitch: { importPhrase: authControl.importPhrase, usePolkadotApp: authControl.logout },
    diagnostics: pageDiagnostics,
    archive: cid => readArchiveFiles(cid, createArchiveTransport(getBackend(), relayBlock)),
    contentInsets: { top: 'var(--content-top)', bottom: 'var(--content-bottom)' },
    topbarPresent: () => topbarState.get().present,
    reportDockInset(inset) {
      layout.setDockInset(inset, 'debug');
    },
    leaveDebugMode: closeDebugMode,
  };
}

/** The page's, docked on the page's product frame layout. */
export const debugPanelHost = createDebugPanelHost({ layout: productFrameLayout });

/** As the sandbox relay serves blocks: from the block cache, else over bitswap. */
async function relayBlock(cid: string): Promise<Uint8Array> {
  return (await blockCache.get(cid)) ?? hostBitswapClient.get(cid);
}
