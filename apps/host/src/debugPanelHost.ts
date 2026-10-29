// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page as the debug panel reads it. Loaded only with the panel, so the diagnostics and the archive reader stay out
// of the boot chunk.

import { fetchBitswapBlock } from '@dotli/bitswap';
import { getBackend, type Backend } from '@dotli/config';
import { readArchiveFiles } from '@dotli/content';
import { blockCache } from '@dotli/storage';
import type { DebugPanelHost } from '@dotli/truapi-debug-ui';
import { setDockInset } from './productFrameLayout.js';
import { getTopbarState } from './state/topbar.js';
import { closeDebugMode } from './settingsActions.js';
import { authControl } from './runtime/createAuthController.js';
import { authState } from './runtime/state/authState.js';
import { pageDiagnostics } from './runtime/createPageDiagnostics.js';
import { productState } from './runtime/state/productState.js';
import { walletModeState } from './runtime/state/walletModeState.js';

/** One block's bytes by CID. */
type BlockSource = (cid: string) => Promise<Uint8Array>;

/** As the sandbox relay serves blocks: from the block cache, else over bitswap. */
const relayBlock: BlockSource = async cid => (await blockCache.get(cid)) ?? fetchBitswapBlock(cid);

/** The Archive tab reads what the sandbox was served: blocks on the light client, the gateway on rpc-gateway. */
export function archiveTransport(
  backend: Backend,
  blockSource: BlockSource,
): { blockSource: BlockSource } | { gateway: true } {
  return backend === 'rpc-gateway' ? { gateway: true } : { blockSource };
}

export const debugPanelHost: DebugPanelHost = {
  product: productState.store,
  auth: authState.store,
  walletMode: walletModeState.store,
  walletSwitch: { importPhrase: authControl.importPhrase, usePolkadotApp: authControl.logout },
  diagnostics: pageDiagnostics,
  archive: cid => readArchiveFiles(cid, archiveTransport(getBackend(), relayBlock)),
  contentInsets: { top: 'var(--content-top)', bottom: 'var(--content-bottom)' },
  topbarPresent: () => getTopbarState().present,
  reportDockInset: inset => {
    setDockInset(inset, 'debug');
  },
  leaveDebugMode: closeDebugMode,
};
