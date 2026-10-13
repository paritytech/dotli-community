// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's TrUAPI chunk, the bridge built over the page's own core runtime, session and frame host.

import { m, spans as S } from '@dotli/metrics';
import { createBridge } from './create-bridge.js';
import { pageCoreRuntimeBoot } from './core-runtime.js';
import { watchHostChains } from './host-callbacks/Chain.js';
import { onStoredSessionChanged } from './host-callbacks/core-storage.js';
import { sessionState } from './host-callbacks/session-state.js';
import { authStore } from './state/auth.js';
import { onPermissionsChanged } from './state/product-permissions.js';
import { getWalletMode } from './state/wallet-mode.js';
import { walletSwitch } from './wallet-switch.js';

// The pool behind these leases already ships in this chunk, so other callers take them from here.
export { hostAssetHubProvider, hostChainProvider } from './host-callbacks/Chain.js';

// Preloaded so they are ready when the first product renders.
const chunkLoadStart = performance.now();
const runtimeChunkPromise = Promise.all([
  import('@parity/truapi-host/web'),
  import('@parity/truapi-host/worker-runtime?worker'),
]).then(([web]) => {
  m.measure(S.BRIDGE_CHUNK_LOAD, performance.now() - chunkLoadStart);
  return { createIframeHost: web.createIframeHost };
});
void runtimeChunkPromise.catch(() => {
  // The render that awaits it reports the failure.
});

export const { initBridge, setPageProduct, startProductFrame, authCommands } = createBridge({
  bootRuntime: pageCoreRuntimeBoot,
  onStoredSessionChanged,
  createIframeHost: async options => (await runtimeChunkPromise).createIframeHost(options),
  container: () => document.getElementById('app') ?? document.body,
  onPermissionsChanged,
  watchChains: watchHostChains,
  auth: authStore,
  session: sessionState,
  walletMode: getWalletMode,
  leaveLocalWallet: () => walletSwitch.usePolkadotApp(),
});
