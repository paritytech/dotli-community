// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's entry. It loads the content for the CID the host passes in the URL contract and wires each step to the
// page's real browser APIs. No name resolution happens here.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { startPage } from './page-start.js';
import { BASE_DOMAIN, TIMEOUTS, getActiveServicesConfig, setNetworkOverride } from '@dotli/config';
import { SANDBOX_CONTRACT_PARAMS } from '@dotli/sandbox-wire';
import { decryptContent, fetchArchive, isEncrypted, parseIpfsResponse } from '@dotli/content';
import { m, setResolutionId } from '@dotli/metrics';
import { endpointHost } from '@dotli/shared';

import { createDecryptIfNeeded } from './decrypt-prompt.js';
import { showError } from '@dotli/ui-widgets';
import { showRetryScreen } from './retry-screen.js';
import { loadPasswordDialog, loadSandboxChecker } from './lazy.js';
import { createPasswordPrompt } from './password-prompt.js';
import { showPasswordPrompt } from './show-password-prompt.js';
import {
  askHostToRerender,
  dismissHostLoading,
  notifyLoadingDone,
  reportSandboxDebug,
  showStatus,
} from './host-messages.js';
import { blockSourcePerDocument, loadProduct, type SandboxParams } from './load-product.js';
import { purgeSandboxOriginState } from './origin-purge.js';
import { runSandbox } from './sandbox-run.js';
import {
  listenForArchiveFailures,
  offerReloadNotice,
  registerAppServiceWorker,
  storeArchiveInSW,
  type AppServiceWorker,
} from './service-worker.js';

startPage();

const T0 = performance.now();

const appWorker: AppServiceWorker = {
  container: 'serviceWorker' in navigator ? navigator.serviceWorker : null,
  version: import.meta.env.VITE_COMMIT_SHA,
  offerReload: offerReloadNotice,
};

const passwordPrompt = createPasswordPrompt({ load: loadPasswordDialog, show: view => showPasswordPrompt(view) });

const decryptIfNeeded = createDecryptIfNeeded({
  prompt: passwordPrompt.prompt,
  preparePrompt: passwordPrompt.prepare,
  dismissHostLoading,
  isEncrypted,
  decryptContent,
  parseIpfsResponse,
});

const loadBlockSource = blockSourcePerDocument(async () => {
  const { createBitswapBridge, hostOriginRule } = await import('./bitswap-bridge.js');
  return createBitswapBridge({ window, parent: window.parent, isHostOrigin: hostOriginRule(BASE_DOMAIN) }).requestBlock;
});

function sinceStart(): number {
  return Math.round(performance.now() - T0);
}

/** The dApp sees only the user's own query params. */
function stripContractParamsFromUrl(): void {
  const cleaned = new URL(window.location.href);
  for (const key of Object.values(SANDBOX_CONTRACT_PARAMS)) {
    cleaned.searchParams.delete(key);
  }
  history.replaceState(null, '', cleaned.toString());
}

/** Inline, since document.write() replaces the page. */
async function maybeInjectSandboxChecker(html: string): Promise<string> {
  if (import.meta.env.VITE_SANDBOX_CHECKER === undefined) {
    return html;
  }
  const { injectSandboxChecker } = await loadSandboxChecker();
  return injectSandboxChecker(html);
}

function configure(params: SandboxParams): void {
  // Before the first load, so a failure in it is still attributed to its page load.
  if (params.resolutionId !== null) {
    setResolutionId(params.resolutionId);
  }
  setNetworkOverride(params.network);
  m.setDefaults({ chain_backend: params.chainBackend, network: params.network });
  listenForArchiveFailures(appWorker.container);
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
        loadBlockSource,
        decrypt: decryptIfNeeded,
        storeArchive: files => storeArchiveInSW(appWorker.container, files),
        prepareHtml: maybeInjectSandboxChecker,
        report: reportSandboxDebug,
        loaded: () => {
          notifyLoadingDone({ outcome: 'loaded' });
        },
        write: html => {
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
      showError(
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
      showRetryScreen();
    },
    askRerender: askHostToRerender,
    gatewayHost: () => endpointHost(getActiveServicesConfig().bulletin.ipfsGateways.at(0)),
    baseDomain: BASE_DOMAIN,
    recoverTimeoutMs: TIMEOUTS.SANDBOX_RECOVER,
  },
);
