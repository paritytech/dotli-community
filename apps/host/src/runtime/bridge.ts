// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's TrUAPI chunk: the bridge over the page's own core runtime, session and frame host, asking the page's
// dialogs, showing its notifications and drawing around the frame with its layout.

import type { ProductAccountId } from '@parity/truapi';
import { getActiveServicesConfig } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import type { LocalWalletReadResult } from '@dotli/protocol';
import { createAsyncTaskPool, createLazyLoad, fromHex, onPageReturn } from '@dotli/shared';
import { siteGrants } from '@dotli/storage';
import { hostPrompts } from '../page-prompts.js';
import { loadHostRuntimeChunk, loadLocalWalletCore, loadPolkadotApi, loadTxFillers } from '../lazy.js';
import { pageNotifications } from '../page-notifications.js';
import { productFrameContainer, productFrameView } from '../product-frame-view.js';
import { recordBestBlock, recordChainActivity } from '../state/network-monitor.js';
import { createBridge } from './create-bridge.js';
import { createCoreAuthCommands, type AuthCommands } from './core-login.js';
import { createCoreRuntimeBoot } from './core-runtime.js';
import { hostChainProvider, watchHostChains } from './host-callbacks/chain.js';
import { pagePermissions, productPermissions } from './page-permissions.js';
import { forgetsSiteGrants, pageRole } from './page-role.js';
import { coreStorage, onStoredSessionChanged, signInFlag, type SessionRead } from './session/core-storage.js';
import { createHostCallbacks, promptAsks } from './host-callbacks/handlers.js';
import { LANDING_PRODUCT } from './page-core.js';
import { windowAsks } from './host-callbacks/window-asks.js';
import { onSessionFlagChange, sessionPresence } from './session/presence.js';
import { onLocalWalletChange } from './session/wallet-changes.js';
import { watchPresence } from './session/presence-watch.js';
import { reconcilePage } from './session/restore-rule.js';
import { createSessionLease } from './session/session-lease.js';
import { sessionState } from './session/session-state.js';
import { siteWallet } from './session/site-wallet.js';
import { createMainAccountSource, type MainAccountSource } from './site-sign-in/main-account.js';
import { createSiteChain } from './site-sign-in/site-chain.js';
import { createSiteSigner } from './site-sign-in/site-signer.js';
import { createSiteTxSigner } from './site-sign-in/site-tx-signer.js';
import { createPageSignOut } from './sign-out.js';
import { pageSignInHandoff } from './session-handoff/opener.js';
import { applySessionResult } from './session-handoff/apply-result.js';
import type { SessionResult } from './session-handoff/messages.js';
import type { WindowFlowDeps } from './session-handoff/window-flow.js';
import type { WindowSignOutDeps } from './session-handoff/window-signout.js';
import { authStore } from './state/auth.js';
import { setSigningOut } from './state/sign-out.js';
import { getWalletMode } from './state/wallet-mode.js';
import { readWalletBoot, restoreOnBoot, serveSites } from './wallet-boot.js';
import { walletSwitch } from './wallet-switch.js';

// Already in this chunk for leaving local mode, so a page with no sign-in window takes it from here for a phrase.
export { walletSwitch } from './wallet-switch.js';

// The pool behind these leases already ships in this chunk, so other callers take them from here.
export { hostAssetHubProvider, hostChainProvider } from './host-callbacks/chain.js';

// Started with debug mode from the boot chunk, which must not import the codecs this file already carries.
export { preloadWireDescriber } from './core-connection.js';

// One load serves the frame and every core.
const hostRuntime = createLazyLoad(async () => {
  const chunkLoadStart = performance.now();
  const runtime = await loadHostRuntimeChunk();
  m.measure(S.BRIDGE_CHUNK_LOAD, performance.now() - chunkLoadStart);
  return runtime;
});
// Preloaded so it is ready when the first product renders.
void hostRuntime().catch(() => {
  // The render or the core boot that asks next loads it again and reports its own failure.
});

// Each core boots on the wallet read from the shared store and the published host runtime, with callbacks that ask
// the page.
const bootRuntime = createCoreRuntimeBoot({
  readWallet: readWalletBoot,
  loadHostRuntime: async () => {
    const { web, HostWorker } = await hostRuntime();
    return { createWebWorkerPairingHostRuntime: web.createWebWorkerPairingHostRuntime, HostWorker };
  },
  createCallbacks: options =>
    createHostCallbacks({
      ...options,
      prompts: hostPrompts,
      notifications: pageNotifications(),
      asks:
        pageRole() === 'signin-window'
          ? windowAsks
          : promptAsks({
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
  onStoredSessionChanged,
  createIframeHost: async options =>
    (await hostRuntime()).web.createIframeHost({ ...options, container: productFrameContainer() }),
  onPermissionsChanged: productPermissions.onChanged,
  permissions: pagePermissions,
  frameView: productFrameView,
  notify: hostPrompts.notify,
  watchChains: () => {
    watchHostChains({ onActivity: recordChainActivity, onBestBlock: recordBestBlock });
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
  serveSites();
}

/**
 * The main account a site's round runs for, as the session window's core reports it. It holds a lease of its own, so
 * the core stays up for a local wallet as for a paired session.
 */
export const mainAccount: MainAccountSource = createMainAccountSource({
  acquire: () => bridge.core.acquire(),
  coreReport: sessionState.coreReport,
});

/** Signs a site's assertion on the page's own core, for the session window. */
export const siteSigner = createSiteSigner({ acquire: () => bridge.core.acquire() });

/** Signs a site's transaction as the account the site names on the page's own core, for the session window. */
export const siteTxSigner = createSiteTxSigner({ acquire: () => bridge.core.acquire() });

/** Asset Hub for the session window, where a site's call is decoded and built into its signed transaction. */
export const siteChain = createSiteChain({
  genesis: () => getActiveServicesConfig().assethub.genesis,
  provider: genesis => hostChainProvider(genesis),
  loadApi: loadPolkadotApi,
  loadFillers: loadTxFillers,
});

const endSession = (blob: string): Promise<void> => bridge.endSession(fromHex(blob));

const coreCommands = createCoreAuthCommands({
  auth: authStore,
  core: bridge.core,
  session: sessionState,
  walletMode: getWalletMode,
  storedSession: coreStorage,
});

const pageSignOut = createPageSignOut({
  walletMode: getWalletMode,
  copy: coreStorage,
  flag: signInFlag,
  endSession,
  cores: bridge.core,
  session: sessionState,
  leaveLocalWallet: forget => walletSwitch.usePolkadotApp(forget),
  // Read per sign-out, as the page's role may be chosen after this is built.
  forgetGrants: () => (forgetsSiteGrants(pageRole()) ? siteGrants.forgetAll() : Promise.resolve()),
  wallet: siteWallet,
  presence: sessionPresence,
  reportSigningOut: setSigningOut,
  signOutWindow: () => pageSignInHandoff(pageRole()),
  signOuts,
  onCore: end => coreCommands.logout(end),
});

/** The page's sign-in on its core, and its sign-out. */
export const authCommands: AuthCommands = {
  login: reason => coreCommands.login(reason),
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
const restoredCopy: {
  readSession: () => Promise<SessionRead>;
  readWallet: () => Promise<LocalWalletReadResult>;
} = {
  readSession: async () => {
    await restoreOnBoot();
    return coreStorage.readSession();
  },
  readWallet: async () => {
    await restoreOnBoot();
    return siteWallet.read();
  },
};

/** The main store for the sign-in window, written through the page's flag keeper. */
export const windowStore: Pick<WindowFlowDeps, 'store' | 'wallet' | 'signIns'> = {
  signIns: signInFlag,
  store: {
    readSession: restoredCopy.readSession,
    readUiCache: () => coreStorage.readUiCache(),
    writeUiCache: value => coreStorage.writeUiCache(value),
  },
  wallet: {
    read: restoredCopy.readWallet,
    save: (entropy, identity) => siteWallet.save(entropy, identity),
    forget: () => siteWallet.forget(),
  },
};

const sessionLease = createSessionLease({
  copy: {
    readSession: restoredCopy.readSession,
    onStoredSessionChanged,
  },
  walletMode: getWalletMode,
  core: bridge.core,
});

/**
 * Starts the page's session lease, for the landing page. It has no product frame to hold a core, so its core hears the
 * phone end the session.
 */
export function startSessionLease(): () => void {
  return sessionLease.start();
}

/** The main store's restore and a core of its own, for the sign-out window. */
export const windowSignOut: Pick<WindowSignOutDeps, 'restore' | 'endSession'> = {
  restore: restoreOnBoot,
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
    onRecheck: handler => {
      const stops = [
        onPageReturn(document, window, handler),
        onSessionFlagChange(handler),
        onLocalWalletChange(handler),
      ];
      return () => {
        for (const stop of stops) {
          stop();
        }
      };
    },
    signedIn: () => authStore.get().tag === 'Connected',
    signOuts,
    reconcile: () => reconcilePage('visible'),
    pageWallet: async () => (getWalletMode() === 'local' ? ((await readWalletBoot())?.version ?? null) : null),
    followWallet: () => {
      window.location.reload();
    },
    signOutLocally: () => pageSignOut.signOutLocally(),
    readFlag: () => sessionPresence.read(),
    reportFlag: presence => {
      sessionState.reportFlag(presence);
    },
  });
  stopSession = () => {
    stopState();
    stopWatch();
    stopSession = null;
  };
  return stopSession;
}
