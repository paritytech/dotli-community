// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's entry. It loads the content for the CID the host passes in the URL contract and wires each step to the
// page's real browser APIs. No name resolution happens here.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import '@dotli/ui/styles.css';
import { BASE_DOMAIN, getActiveServicesConfig, setActiveNetwork } from '@dotli/config';
import { decryptContent, fetchArchive, isEncrypted, parseIpfsResponse } from '@dotli/content';
import { m, setResolutionId } from '@dotli/metrics';
import { endpointHost } from '@dotli/shared';

import { createDecryptIfNeeded } from './decrypt-prompt.js';
import { SANDBOX_TIMEOUTS } from './timeouts.js';
import { listenForChunkFailures, showNotification, toastsStore } from '@dotli/ui';
import { loadPageUi, loadSandboxChecker } from './lazy.js';
import { hideFallbackScreen, showFallbackScreen } from './fallback-screen.js';
import { createSandboxUi } from './sandbox-ui.js';
import { showPasswordPrompt } from './show-password-prompt.js';
import {
  askHostToRerender,
  dismissHostLoading,
  notifyLoadingDone,
  reportSandboxDebug,
  showStatus,
} from './host-messages.js';
import { withoutContractParams } from './contract-url.js';
import { createBitswapBridge, hostOriginRule } from './bitswap-bridge.js';
import { loadProduct, type BlockSource, type SandboxParams } from './load-product.js';
import { purgeSandboxOriginState } from './origin-purge.js';
import { runSandbox } from './sandbox-run.js';
import {
  listenForArchiveFailures,
  offerReloadNotice,
  registerAppServiceWorker,
  storeArchiveInSW,
  type AppServiceWorker,
} from './service-worker.js';

listenForChunkFailures({
  target: window,
  notify: showNotification,
  reload: () => {
    window.location.reload();
  },
});

const ui = createSandboxUi({
  load: loadPageUi,
  toasts: toastsStore,
  showFallback: text => {
    showFallbackScreen(document, text, () => {
      window.location.reload();
    });
  },
  hideFallback: () => {
    hideFallbackScreen(document);
  },
});

const T0 = performance.now();

const appWorker: AppServiceWorker = {
  container: 'serviceWorker' in navigator ? navigator.serviceWorker : null,
  version: import.meta.env.VITE_COMMIT_SHA,
  offerReload: offerReloadNotice,
};

const decryptIfNeeded = createDecryptIfNeeded({
  prompt: async options => showPasswordPrompt((await ui.ready()).passwordPromptDialog(options)),
  dismissHostLoading,
  isEncrypted,
  decryptContent,
  parseIpfsResponse,
});

function sinceStart(): number {
  return Math.round(performance.now() - T0);
}

/** The dApp sees only the user's own query params. */
function stripContractParamsFromUrl(): void {
  history.replaceState(null, '', withoutContractParams(window.location.href));
}

/** Inline, since document.write() replaces the page. */
async function maybeInjectSandboxChecker(html: string): Promise<string> {
  if (import.meta.env.VITE_SANDBOX_CHECKER !== 'true') {
    return html;
  }
  const { injectSandboxChecker } = await loadSandboxChecker();
  return injectSandboxChecker(html);
}

// One bridge for the document, so every retry reuses its listeners. Built in `configure`, once the backend is known.
let blockSource: BlockSource | null = null;

function configure(params: SandboxParams): void {
  // Before the first load, so a failure in it is still attributed to its page load.
  if (params.resolutionId !== null) {
    setResolutionId(params.resolutionId);
  }
  setActiveNetwork(params.network);
  m.setDefaults({ chain_backend: params.backend, network: params.network });
  listenForArchiveFailures(appWorker.container);
  if (params.backend !== 'rpc-gateway') {
    blockSource = createBitswapBridge({
      window,
      parent: window.parent,
      isHostOrigin: hostOriginRule(BASE_DOMAIN),
    }).requestBlock;
  }
}

void runSandbox(
  { href: window.location.href, framed: window.self !== window.top },
  {
    configure,
    load: input =>
      loadProduct(input, {
        showStatus,
        purge: () =>
          purgeSandboxOriginState({
            indexedDB: typeof indexedDB === 'undefined' ? null : indexedDB,
            caches: typeof caches === 'undefined' ? null : caches,
            serviceWorker: appWorker.container,
            localStorage: () => localStorage,
            sessionStorage: () => sessionStorage,
            document,
            pathname: window.location.pathname,
          }),
        registerWorker: options => registerAppServiceWorker(appWorker, options),
        fetchArchive,
        blockSource,
        decrypt: decryptIfNeeded,
        storeArchive: files => storeArchiveInSW(appWorker.container, files),
        prepareHtml: maybeInjectSandboxChecker,
        report: reportSandboxDebug,
        loaded: () => {
          notifyLoadingDone({ outcome: 'loaded' });
        },
        write: html => {
          ui.close();
          stripContractParamsFromUrl();
          document.open();
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional: document.write replaces the page with dApp content to eliminate triple iframe nesting
          document.write(html);
          document.close();
        },
        sinceStart,
      }),
    failed: step => {
      notifyLoadingDone({ outcome: 'failed', failedStep: step });
    },
    show: (title, message, retry) => {
      ui.showError(
        title,
        message,
        retry === undefined
          ? undefined
          : () => {
              void retry();
            },
      );
    },
    retrying: () => {
      ui.showRetryScreen();
    },
    askRerender: askHostToRerender,
    gatewayHost: () => endpointHost(getActiveServicesConfig().bulletin.ipfsGateways.at(0)),
    baseDomain: BASE_DOMAIN,
    recoverTimeoutMs: SANDBOX_TIMEOUTS.RECOVER,
  },
);
