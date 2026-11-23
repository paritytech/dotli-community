// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page as the debug panel reads it. Loaded only with the panel, so the diagnostics and the archive reader stay out
// of the boot chunk.

import type { DebugPanelHost } from '@dotli/truapi-debug-ui';
import { getCacheSettings } from '@dotli/config';
import { blockCache } from '@dotli/storage';
import { hostBitswapClient } from '../chains/index.js';
import { productFrameLayout, type ProductFrameLayout } from '../page/index.js';
import { readServedArchive } from '../productLoad/index.js';
import { topbarState } from '../page/index.js';
import { closeDebugMode } from '../debug/index.js';
import { authControl } from '../account/index.js';
import { authState } from '../account/index.js';
import { pageDiagnostics } from './createPageDiagnostics.js';
import { productState } from '../page/index.js';
import { walletModeState } from '../account/index.js';

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
    archive: cid => readServedArchive(cid, hostBitswapClient, getCacheSettings().skipArchiveCache ? null : blockCache),
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
