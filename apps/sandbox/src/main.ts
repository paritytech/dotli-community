// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's entry. It loads the content for the CID the host passes in the URL contract and wires each step to the
// page's real browser APIs. No name resolution happens here.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import '@dotli/ui/styles.css';
import { BASE_DOMAIN, getActiveServicesConfig, hasLightClient, setActiveNetwork } from '@dotli/config';
import { decryptContent, fetchArchive, isEncrypted, parseIpfsResponse } from '@dotli/content';
import { m, setResolutionId } from '@dotli/metrics';
import { getEndpointHost } from '@dotli/shared';

import { createDecryptIfNeeded } from './createDecryptIfNeeded.js';
import { SANDBOX_TIMEOUTS } from './timeouts.js';
import { createReloadOffer, listenForChunkFailures, showNotification, toasts } from '@dotli/ui';
import { loadPageUi, loadSandboxChecker } from './lazy.js';
import { createFallbackScreen } from './createFallbackScreen.js';
import { createSandboxUi } from './createSandboxUi.js';
import { showPasswordPrompt } from './showPasswordPrompt.js';
import { createHostMessages } from './createHostMessages.js';
import { stripContractParams } from './stripContractParams.js';
import { createBitswapBridge, createHostOriginRule } from './createBitswapBridge.js';
import { loadProduct, type BlockSource, type SandboxParams } from './loadProduct.js';
import { purgeSandboxOriginState } from './purgeSandboxOriginState.js';
import { runSandbox } from './runSandbox.js';
import { waitForRecoverAccepted } from './waitForRecoverAccepted.js';
import { listenForArchiveFailures } from './listenForArchiveFailures.js';
import { offerReloadNotice } from './offerReloadNotice.js';
import { registerAppServiceWorker, type AppServiceWorker } from './registerAppServiceWorker.js';
import { storeArchiveInServiceWorker } from './storeArchiveInServiceWorker.js';

listenForChunkFailures({
  target: window,
  offerReload: createReloadOffer({ notify: showNotification, reload: reloadPage }),
});

const hostMessages = createHostMessages({ parent: window.parent });

const isHostOrigin = createHostOriginRule(BASE_DOMAIN);

const fallbackScreen = createFallbackScreen({ page: document, reload: reloadPage });

const ui = createSandboxUi({
  load: loadPageUi,
  toasts: toasts.store,
  showFallback: fallbackScreen.show,
  hideFallback: fallbackScreen.hide,
});

const STARTED_AT = performance.now();

const appWorker: AppServiceWorker = {
  container: 'serviceWorker' in navigator ? navigator.serviceWorker : null,
  version: import.meta.env.VITE_COMMIT_SHA,
  offerReload: offerReloadNotice,
};

const decryptIfNeeded = createDecryptIfNeeded({
  prompt: async options => showPasswordPrompt((await ui.loadUi()).createPasswordPromptView(options)),
  dismissHostLoading: hostMessages.dismissLoading,
  isEncrypted,
  decryptContent,
  parseIpfsResponse,
});

function reloadPage(): void {
  window.location.reload();
}

function measureSinceStart(): number {
  return Math.round(performance.now() - STARTED_AT);
}

/** The dApp sees only the user's own query params. */
function stripContractParamsFromUrl(): void {
  history.replaceState(null, '', stripContractParams(window.location.href));
}

/** Replaces this document with the product's page. */
function writeProductPage(html: string): void {
  ui.dispose();
  stripContractParamsFromUrl();
  document.open();
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional: document.write replaces the page with dApp content to eliminate triple iframe nesting
  document.write(html);
  document.close();
}

/** Shows the run's failure on the sandbox's error page, with its retry. */
function showFailure(title: string, message: string, { retry }: { retry?: (() => Promise<void>) | undefined }): void {
  if (retry === undefined) {
    ui.showError(title, message);
    return;
  }
  ui.showError(title, message, {
    retry: () => {
      void retry();
    },
  });
}

/** Inline, since document.write() replaces the page. */
async function injectCheckerIfEnabled(html: string): Promise<string> {
  if (import.meta.env.VITE_SANDBOX_CHECKER !== 'true') {
    return html;
  }
  const { injectSandboxChecker } = await loadSandboxChecker();
  return injectSandboxChecker(html);
}

// One bridge for the document, so every retry reuses its listeners. Built in `configure`, once the backend is known.
let blockSource: BlockSource | null = null;

function configure(params: SandboxParams): void {
  // Said at once, since the sandbox must not stay silent, and the purge before the next progress can take seconds.
  hostMessages.showStatus('Starting the app');
  // Before the first load, so a failure in it is still attributed to its page load.
  if (params.resolutionId !== null) {
    setResolutionId(params.resolutionId);
  }
  setActiveNetwork(params.network);
  m.setDefaults({ chain_backend: params.backend, network: params.network });
  // The listener lives as long as the sandbox page, so its stop goes unused.
  listenForArchiveFailures(appWorker.container);
  if (hasLightClient(params.backend)) {
    // The bridge lives as long as the sandbox page, so nothing disposes it.
    blockSource = createBitswapBridge({
      window,
      parent: window.parent,
      isHostOrigin,
    }).requestBlock;
  }
}

void runSandbox(
  { href: window.location.href, framed: window.self !== window.top },
  {
    configure,
    load: input =>
      loadProduct(input, {
        showStatus: hostMessages.showStatus,
        purge: () =>
          purgeSandboxOriginState({
            indexedDB: typeof indexedDB === 'undefined' ? null : indexedDB,
            caches: typeof caches === 'undefined' ? null : caches,
            serviceWorker: appWorker.container,
            getLocalStorage: () => localStorage,
            getSessionStorage: () => sessionStorage,
            document,
            pathname: window.location.pathname,
          }),
        registerWorker: options => registerAppServiceWorker(appWorker, options),
        isControlled: () => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null,
        fetchArchive,
        blockSource,
        decrypt: decryptIfNeeded,
        storeArchive: files =>
          storeArchiveInServiceWorker({ container: appWorker.container, files, pagePath: window.location.pathname }),
        prepareHtml: injectCheckerIfEnabled,
        report: hostMessages.reportDebug,
        notifyLoaded: () => {
          hostMessages.notifyLoadingDone({ outcome: 'loaded' });
        },
        write: writeProductPage,
        measureSinceStart,
      }),
    notifyFailed: step => {
      hostMessages.notifyLoadingDone({ outcome: 'failed', failedStep: step });
    },
    show: showFailure,
    showRetrying: () => {
      ui.showRetryScreen();
    },
    askRerender: hostMessages.askRerender,
    waitForRecoverAccepted: signal => waitForRecoverAccepted({ window, parent: window.parent, isHostOrigin, signal }),
    getGatewayHost: () => getEndpointHost(getActiveServicesConfig().bulletin.ipfsGateways.at(0)),
    baseDomain: BASE_DOMAIN,
    recoverTimeoutMs: SANDBOX_TIMEOUTS.RECOVER,
  },
);
