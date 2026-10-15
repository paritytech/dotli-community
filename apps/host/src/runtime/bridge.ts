// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's TrUAPI chunk: the bridge over the page's own core runtime, session and frame host, asking the page's
// dialogs, showing its notifications and drawing around the frame with its layout.

import { m, spans as S } from '@dotli/metrics';
import { hostPrompts } from '../page-prompts.js';
import { loadHostRuntimeChunk, loadLocalWalletCore } from '../lazy.js';
import { pageNotifications } from '../page-notifications.js';
import { productFrameContainer, productFrameView } from '../product-frame-view.js';
import { recordBestBlock, recordChainActivity } from '../state/network-monitor.js';
import { createBridge } from './create-bridge.js';
import { createCoreRuntimeBoot } from './core-runtime.js';
import { watchHostChains } from './host-callbacks/chain.js';
import { onStoredSessionChanged } from './session/core-storage.js';
import { createHostCallbacks } from './host-callbacks/handlers.js';
import { sessionState } from './session/session-state.js';
import { authStore } from './state/auth.js';
import { onPermissionsChanged } from './state/product-permissions.js';
import { getWalletMode } from './state/wallet-mode.js';
import { readWalletBoot } from './wallet-boot.js';
import { walletSwitch } from './wallet-switch.js';

// The pool behind these leases already ships in this chunk, so other callers take them from here.
export { hostAssetHubProvider, hostChainProvider } from './host-callbacks/chain.js';
// Started from here, so the session state and the TrUAPI codecs it reads stay in this chunk.
export { startSessionState } from './session/session-state.js';

// Started with debug mode from the boot chunk, which must not import the codecs this file already carries.
export { preloadWireDescriber } from './core-connection.js';

// Preloaded so it is ready when the first product renders. One load serves the frame and every core.
const chunkLoadStart = performance.now();
const hostRuntime = loadHostRuntimeChunk().then(runtime => {
  m.measure(S.BRIDGE_CHUNK_LOAD, performance.now() - chunkLoadStart);
  return runtime;
});
void hostRuntime.catch(() => {
  // The render or the core boot that awaits it reports the failure.
});

// Each core boots on the wallet read from the shared store and the published host runtime, with callbacks that ask
// the page.
const bootRuntime = createCoreRuntimeBoot({
  readWallet: readWalletBoot,
  loadHostRuntime: async () => {
    const { web, HostWorker } = await hostRuntime;
    return { createWebWorkerPairingHostRuntime: web.createWebWorkerPairingHostRuntime, HostWorker };
  },
  createCallbacks: options =>
    createHostCallbacks({ ...options, prompts: hostPrompts, notifications: pageNotifications() }),
  loadLocalWalletCore,
});

export const { initBridge, setPageProduct, startProductFrame, authCommands } = createBridge({
  bootRuntime,
  onStoredSessionChanged,
  createIframeHost: async options =>
    (await hostRuntime).web.createIframeHost({ ...options, container: productFrameContainer() }),
  onPermissionsChanged,
  frameView: productFrameView,
  notify: hostPrompts.notify,
  watchChains: () => {
    watchHostChains({ onActivity: recordChainActivity, onBestBlock: recordBestBlock });
  },
  auth: authStore,
  session: sessionState,
  walletMode: getWalletMode,
  leaveLocalWallet: () => walletSwitch.usePolkadotApp(),
});
