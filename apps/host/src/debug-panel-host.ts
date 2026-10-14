// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page as the debug panel reads it. Loaded only with the panel, so the diagnostics, the wallet switch, the archive
// reader and the recovery phrase check stay out of the boot chunk.

import { bitswapGet } from '@dotli/bitswap';
import { getBackend, type Backend } from '@dotli/config';
import { readArchiveFiles } from '@dotli/content';
import { getCachedBlock } from '@dotli/storage';
import type { DebugPanelHost } from '@dotli/truapi-debug-ui';
import { setDockInset } from './product-frame-layout.js';
import { getTopbarState } from './state/topbar.js';
import { closeDebugMode } from './settings-actions.js';
import { authStore } from './runtime/state/auth.js';
import { pageDiagnostics } from './runtime/diagnostics.js';
import { phraseToEntropy } from './runtime/recovery-phrase.js';
import { productStore } from './runtime/state/product.js';
import { walletModeStore } from './runtime/state/wallet-mode.js';
import { walletSwitch } from './runtime/wallet-switch.js';

/** One block's bytes by CID. */
type BlockSource = (cid: string) => Promise<Uint8Array>;

/** As the sandbox relay serves blocks: from the block cache, else over bitswap. */
const relayBlock: BlockSource = async cid => (await getCachedBlock(cid)) ?? bitswapGet(cid);

/** The Archive tab reads what the sandbox was served: blocks on the light client, the gateway on rpc-gateway. */
export function archiveTransport(
  backend: Backend,
  blockSource: BlockSource,
): { blockSource: BlockSource } | { gateway: true } {
  return backend === 'rpc-gateway' ? { gateway: true } : { blockSource };
}

export const debugPanelHost: DebugPanelHost = {
  product: productStore,
  auth: authStore,
  walletMode: walletModeStore,
  walletSwitch,
  phraseToEntropy,
  diagnostics: pageDiagnostics,
  archive: cid => readArchiveFiles(cid, archiveTransport(getBackend(), relayBlock)),
  contentInsets: { top: 'var(--content-top)', bottom: 'var(--content-bottom)' },
  topbarPresent: () => getTopbarState().present,
  reportDockInset: inset => {
    setDockInset(inset, 'debug');
  },
  leaveDebugMode: closeDebugMode,
};
