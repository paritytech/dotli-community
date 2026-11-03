// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's TrUAPI chunk: the bridge over the page's own core runtime, session and frame host, asking the page's
// dialogs, showing its notifications and drawing around the frame with its layout.

import type { ProductAccountId } from '@parity/truapi';
import { getActiveServicesConfig } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import type { LocalWalletReadResult } from '@dotli/protocol';
import { createAsyncTaskPool, createLazyLoad, fromHex, listenForPageReturn, markHandled } from '@dotli/shared';
import { siteGrants } from '@dotli/storage';
import { hostPrompts } from '../createHostPrompts.js';
import { loadHostRuntimeChunk, loadLocalWalletCore, loadPolkadotApi, loadTxFillers } from '../lazy.js';
import { pageNotifications } from '../pageNotifications.js';
import { getProductFrameContainer, productFrameView } from '../createProductFrameView.js';
import { networkMonitorState } from '../state/networkMonitorState.js';
import { createBridge } from './createBridge.js';
import type { AuthCommands } from './createAuthCommands.js';
import { createCoreAuthCommands } from './createCoreAuthCommands.js';
import { createCoreRuntimeBoot } from './createCoreRuntimeBoot.js';
import { getHostChainProvider } from './hostCallbacks/getHostChainProvider.js';
import { watchHostChains } from './hostCallbacks/watchHostChains.js';
import { pagePermissions, productPermissions } from './pagePermissions.js';
import { isSiteGrantForgotten, pageRole } from './pageRole.js';
import { coreStorage, signInFlag, type SessionRead } from './session/createCoreStorage.js';
import { createHostCallbacks } from './hostCallbacks/createHostCallbacks.js';
import { createPromptAsks } from './hostCallbacks/createPromptAsks.js';
import { LANDING_PRODUCT, type CoreLease } from './createPageCore.js';
import { getWindowAsks } from './hostCallbacks/getWindowAsks.js';
import { listenForSessionFlagChange, sessionPresence } from './session/createPagePresence.js';
import { listenForSiteWalletChange } from './session/listenForLocalWalletChange.js';
import { watchPresence } from './session/watchPresence.js';
import { reconcilePage } from './session/restoreRule.js';
import { createSessionLease } from './session/createSessionLease.js';
import { sessionState } from './session/createSessionState.js';
import { siteWallet } from './session/siteWallet.js';
import { createMainAccountSource, type MainAccountSource } from './siteSignIn/createMainAccountSource.js';
import { createSiteChain } from './siteSignIn/createSiteChain.js';
import { createSiteAccountReader } from './siteSignIn/createSiteAccountReader.js';
import { createSiteTxSigner } from './siteSignIn/createSiteTxSigner.js';
import { createPageSignOut } from './createPageSignOut.js';
import { applySessionResult } from './sessionHandoff/applySessionResult.js';
import { getPageSignInHandoff } from './sessionHandoff/createSessionHandoff.js';
import type { WindowFlowParams } from './sessionHandoff/createWindowFlow.js';
import type { SessionResult } from './sessionHandoff/parseSessionResult.js';
import type { WindowSignOutParams } from './sessionHandoff/signOutInWindow.js';
import { authState } from './state/authState.js';
import { signingOutState } from './state/signingOutState.js';
import { walletModeState } from './state/walletModeState.js';
import { pageWalletBoot } from './createWalletBoot.js';
import { walletSwitch } from './createWalletSwitch.js';

// Already in this chunk for leaving local mode, so a page with no sign-in window takes it from here for a phrase.
export { walletSwitch } from './createWalletSwitch.js';

// The pool behind these leases already ships in this chunk, so other callers take them from here.
export { getHostAssetHubProvider, getHostChainProvider } from './hostCallbacks/getHostChainProvider.js';

// Started with debug mode from the boot chunk, which must not import the codecs this file already carries.
export { wireDescriber } from './createWireDescriber.js';

// One load serves the frame and every core.
const hostRuntime = createLazyLoad({
  async load() {
    const chunkLoadStart = performance.now();
    const runtime = await loadHostRuntimeChunk();
    m.measure(S.BRIDGE_CHUNK_LOAD, performance.now() - chunkLoadStart);
    return runtime;
  },
});
// Preloaded so it is ready when the first product renders.
// The render or the core boot that asks next loads it again and reports its own failure.
void markHandled(hostRuntime());

// Each core boots on the wallet read from the shared store and the published host runtime, with callbacks that ask
// the page.
const bootRuntime = createCoreRuntimeBoot({
  readWallet: pageWalletBoot.read,
  async loadHostRuntime() {
    const { web, HostWorker } = await hostRuntime();
    return { createWebWorkerPairingHostRuntime: web.createWebWorkerPairingHostRuntime, HostWorker };
  },
  createCallbacks: options =>
    createHostCallbacks({
      ...options,
      prompts: hostPrompts,
      notifications: pageNotifications(),
      createAsks:
        pageRole.get() === 'signin-window'
          ? getWindowAsks
          : createPromptAsks({
              prompts: hostPrompts,
              permissions: { registry: pagePermissions, product: productPermissions },
            }),
    }),
  loadLocalWalletCore,
});

// The page's own sign-out and the restore rule's visible checks run here one at a time.
const signOuts = createAsyncTaskPool({ poolSize: 1 });

const bridge = createBridge({
  bootRuntime,
  subscribeStoredSession: coreStorage.subscribeStoredSession,
  createIframeHost: async params =>
    (await hostRuntime()).web.createIframeHost({ ...params, container: getProductFrameContainer() }),
  subscribePermissionChanges: productPermissions.subscribeChanges,
  permissions: pagePermissions,
  frameView: productFrameView,
  notify: hostPrompts.notify,
  watchChains: () => {
    // The watch lasts the page's life, so its stop goes unused.
    watchHostChains({
      onActivity: networkMonitorState.recordChainActivity,
      onBestBlock: networkMonitorState.recordBestBlock,
    });
  },
  session: sessionState,
});

export const { initBridge, setPageProduct, startProductFrame } = bridge;

// Whether the window already serves a site, which it decides once per page.
let servingSite = false;

/**
 * The session window serves a site's round, with dot.li's own pairing, and boots on a stored local wallet. With an
 * `account`, a transaction's, its core runs under that account's product id. With null, a sign-in's, its core runs as
 * dot.li's own product. Called before anything boots a core. Once per page, so a second call does nothing.
 */
export function serveSite(account: ProductAccountId | null): void {
  if (servingSite) {
    return;
  }
  servingSite = true;
  if (account !== null) {
    // dot.li's own pairing, as the site never names the window's product.
    setPageProduct({ ...LANDING_PRODUCT, label: account.dotNsIdentifier, productId: account.dotNsIdentifier });
  }
  pageWalletBoot.serveSites();
}

// The main account source lives as long as the page, so nothing disposes it.
/**
 * The main account a site's round runs for, as the session window's core reports it. It holds a lease of its own, so
 * the core stays up for a local wallet as for a paired session.
 */
export const mainAccount: MainAccountSource = createMainAccountSource({
  acquire: () => bridge.core.acquire(),
  coreReport: sessionState.coreReport,
});

/** Reads the key of the account a site names on the page's own core, for the session window. */
export const siteAccountReader = createSiteAccountReader({ acquire: () => bridge.core.acquire() });

/** Signs a site's transaction as the account the site names on the page's own core, for the session window. */
export const siteTxSigner = createSiteTxSigner({ acquire: () => bridge.core.acquire() });

/** Asset Hub for the session window, where a site's call is decoded and built into its signed transaction. */
export const siteChain = createSiteChain({
  genesis: () => getActiveServicesConfig().assethub.genesis,
  provider: genesis => getHostChainProvider(genesis),
  loadApi: loadPolkadotApi,
  loadFillers: loadTxFillers,
});

function endSession(blob: string): Promise<void> {
  return bridge.endSession(fromHex(blob));
}

const coreCommands = createCoreAuthCommands({
  auth: authState.store,
  core: bridge.core,
  session: sessionState,
  walletMode: walletModeState.getMode,
  storedSession: coreStorage,
});

const pageSignOut = createPageSignOut({
  walletMode: walletModeState.getMode,
  copy: coreStorage,
  flag: signInFlag,
  endSession,
  cores: bridge.core,
  session: sessionState,
  leaveLocalWallet: forget => walletSwitch.usePolkadotApp(forget),
  // Read per sign-out, as the page's role may be chosen after this is built.
  forgetGrants: () => (isSiteGrantForgotten(pageRole.get()) ? siteGrants.forgetAll() : Promise.resolve()),
  wallet: siteWallet,
  presence: sessionPresence,
  reportSigningOut: signingOutState.set,
  signOutWindow: () => getPageSignInHandoff(pageRole.get()),
  signOuts,
  runOnCore: end => coreCommands.logout(end),
});

/** The page's sign-in on its core, and its sign-out. */
export const authCommands: AuthCommands = {
  login: params => coreCommands.login(params),
  logout: () => pageSignOut.signOut(),
  cancelLogin: () => {
    coreCommands.cancelLogin();
  },
};

/** Writes the sign-in window's result into this page's copy, where this page's cores pick it up. */
export function applyWindowResult(result: SessionResult): Promise<'applied' | 'reloading'> {
  return applySessionResult(result, {
    installSession: (blob, uiState) => coreStorage.installSession(blob, uiState),
    readWallet: () => siteWallet.read(),
    saveWallet: (entropy, identity) => siteWallet.save(entropy, identity),
    reload: () => {
      window.location.reload();
    },
  });
}

// Reads wait for the restore rule: before it ran, the copy may hold a session the flag says is gone, and the wallet
// mode still reads its default.
async function readRestoredSession(): Promise<SessionRead> {
  await pageWalletBoot.restore();
  return coreStorage.readSession();
}

async function readRestoredWallet(): Promise<LocalWalletReadResult> {
  await pageWalletBoot.restore();
  return siteWallet.read();
}

/** The main store for the sign-in window, written through the page's flag keeper. */
export const windowStore: Pick<WindowFlowParams, 'store' | 'wallet' | 'signIns'> = {
  signIns: signInFlag,
  store: {
    readSession: readRestoredSession,
    readUiCache: () => coreStorage.readUiCache(),
    writeUiCache: value => coreStorage.writeUiCache(value),
  },
  wallet: {
    read: readRestoredWallet,
    save: (entropy, identity) => siteWallet.save(entropy, identity),
    forget: () => siteWallet.forget(),
  },
};

const sessionLease = createSessionLease({
  copy: {
    readSession: readRestoredSession,
    subscribeStoredSession: coreStorage.subscribeStoredSession,
  },
  walletMode: walletModeState.getMode,
  core: bridge.core,
});

/**
 * Starts the page's session lease, for the landing page. It has no product frame to hold a core, so its core hears the
 * phone end the session.
 */
export function startSessionLease(): () => void {
  return sessionLease.start();
}

/**
 * Leases the core of the page's product, dialing it when none serves that product, so it boots before the product
 * renders. Rejects with the boot's error, or `CoreRedialError` when a replacement could not boot. Throws before
 * `initBridge`.
 */
export function acquirePageCore(): Promise<CoreLease> {
  return bridge.core.acquire();
}

/** The main store's restore and a core of its own, for the sign-out window. */
export const windowSignOut: Pick<WindowSignOutParams, 'restore' | 'endSession'> = {
  restore: pageWalletBoot.restore,
  endSession,
};

// A repeated boot call must not start a second watch, which would read the flag and sign out twice, so later calls
// share the first start.
let stopSession: (() => void) | null = null;

/**
 * Starts the session state at once at boot, since the auth button spins until the saved session is read. Started from
 * here, so the session state and the TrUAPI codecs it reads stay in this chunk. A second call returns the first one's
 * stop.
 */
export function startSessionState(): () => void {
  if (stopSession !== null) {
    return stopSession;
  }
  const stopState = sessionState.start();
  const stopWatch = watchPresence({
    subscribeRecheck(handler) {
      const stops = [
        listenForPageReturn({ visibility: document, target: window, handler }),
        listenForSessionFlagChange(handler),
        listenForSiteWalletChange(handler),
      ];

      function unsubscribe(): void {
        for (const stop of stops) {
          stop();
        }
      }

      return unsubscribe;
    },
    isSignedIn: () => authState.store.get().tag === 'Connected',
    signOuts,
    reconcile: () => reconcilePage('visible'),
    readPageWalletVersion: async () =>
      walletModeState.getMode() === 'local' ? ((await pageWalletBoot.read())?.version ?? null) : null,
    followWallet: () => {
      window.location.reload();
    },
    signOutLocally: () => pageSignOut.signOutLocally(),
    readFlag: () => sessionPresence.read(),
    reportFlag: presence => {
      sessionState.reportFlag(presence);
    },
  });
  stopSession = stopSessionState;
  return stopSession;

  function stopSessionState(): void {
    stopState();
    stopWatch();
    stopSession = null;
  }
}
