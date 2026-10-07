// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fetches and verifies the content for the CID the host passes in the URL contract. No name resolution happens here.

import '@dotli/ui/styles.css';
import {
  initSentry,
  installGlobalErrorHandlers,
  captureException,
  recordExpected,
  m,
  setResolutionId,
  spans as S,
} from '@dotli/metrics';
import { showNotification, prefetchOverlays, showError, showPasswordPrompt, showRetryScreen } from '@dotli/ui';

// The user opts into a reload rather than getting a silent one.
window.addEventListener('vite:preloadError', event => {
  const evt = event as unknown as { payload?: unknown };
  captureException(evt.payload ?? new Error('vite:preloadError'), { flow: 'boot', step: 'chunk_preload' });
  showNotification({
    label: 'Asset failed to load',
    text: 'A new version may have been deployed. Reload to get the latest.',
    tone: 'err',
    dismissMs: 0,
    action: {
      label: 'Reload',
      onClick: () => {
        window.location.reload();
      },
    },
  });
});

// In memory before a deploy could make later chunk loads fail.
prefetchOverlays();

import {
  CONTENT_ERRORS,
  packArchive,
  type ArchiveFiles,
  isEncrypted,
  decryptContent,
  parseIpfsResponse,
  loadFetch,
} from '@dotli/content';
import type { FetchResult } from '@dotli/content';

import {
  TIMEOUTS,
  BASE_DOMAIN,
  SANDBOX_CONTRACT_PARAMS,
  validateSandboxParams,
  getActiveServicesConfig,
  setNetworkOverride,
} from '@dotli/config';

import { endpointHost, gatewayUnreachable, log } from '@dotli/shared';

import { SANDBOX_ERRORS } from './errors.js';

initSentry('sandbox');
installGlobalErrorHandlers('sandbox');
import { loadSandboxChecker } from '@dotli/sandbox-checker';

const T0 = performance.now();

function sinceStart(): number {
  return Math.round(performance.now() - T0);
}

const contentLog = log.child({ flow: 'content' });

/**
 * Named alike in Sentry and in the host's `failedStep`. `verify` is never entered: a content mismatch is attributed to
 * it from whichever step fetched or parsed the bytes.
 */
type LoadStep =
  | 'contract_top_level'
  | 'contract_origin'
  | 'contract_params'
  | 'contract_rerender'
  | 'retry_limit'
  | 'init'
  | 'sw_register'
  | 'chunk_load'
  | 'content_fetch'
  | 'verify'
  | 'decrypt'
  | 'sw_store'
  | 'archive_index'
  | 'render';

let loadStep: LoadStep = 'init';

function failedStepOf(err: unknown): LoadStep {
  return err instanceof Error && err.name === CONTENT_ERRORS.VERIFICATION ? 'verify' : loadStep;
}

// `main()` rejects top-level loads, so these always post to the host parent.

function showStatus(message: string): void {
  window.parent.postMessage({ type: 'dotli:loading-status', message }, '*');
}

function notifyLoadingDone(result: { outcome: 'loaded' } | { outcome: 'failed'; failedStep: LoadStep }): void {
  window.parent.postMessage({ type: 'dotli:loading-status', done: true, ...result }, '*');
}

/** For a prompt shown before the content has loaded. */
function dismissHostLoading(): void {
  window.parent.postMessage({ type: 'dotli:loading-status', done: true }, '*');
}

function resultBytes(result: FetchResult): number {
  return result.type === 'single'
    ? result.content.byteLength
    : Object.values(result.files).reduce((sum, file) => sum + file.byteLength, 0);
}

function resultFileCount(result: FetchResult): number {
  return result.type === 'single' ? 1 : Object.keys(result.files).length;
}

/** The host relays it to its debug bus. Sent always, since only the host knows whether the panel is open. */
function reportSandboxDebug(event: string, flowId: string, payload: Record<string, unknown>): void {
  window.parent.postMessage(
    {
      type: 'dotli:debug-event',
      event: {
        layer: 'sandbox',
        event,
        flowId,
        timestamp: Date.now(),
        payload,
      },
    },
    '*',
  );
}

/** The dApp sees only the user's own query params. */
function stripContractParamsFromUrl(): void {
  const cleaned = new URL(window.location.href);
  for (const key of Object.values(SANDBOX_CONTRACT_PARAMS)) {
    cleaned.searchParams.delete(key);
  }
  history.replaceState(null, '', cleaned.toString());
}

/**
 * A reload of this window boots without the contract params, which were stripped. The host can re-render with the
 * params it last threaded, and if it does not in time, the load fails as a contract error.
 */
function requestHostRerender(reason: string): void {
  log.event('Asking the host to re-render the sandbox', { flow: 'content', reason });
  showStatus('Restoring app...');
  window.parent.postMessage({ type: 'dotli:sandbox-recover' }, '*');
  window.setTimeout(() => {
    failContract('contract_rerender', 'Invalid sandbox URL', reason);
  }, TIMEOUTS.SANDBOX_RECOVER);
}

/** Also ends the host's loading screen, or it stays stacked over the error page. */
function failLoading(step: LoadStep, ...args: Parameters<typeof showError>): void {
  notifyLoadingDone({ outcome: 'failed', failedStep: step });
  showError(...args);
}

/** Reported, since a URL this sandbox cannot use is the host's fault, never the visitor's. */
function failContract(step: LoadStep, title: string, reason: string): void {
  const err = new Error(`${title}: ${reason}`);
  err.name = 'SandboxContractError';
  captureException(err, { flow: 'content', step, tags: { surface: 'sandbox_main' } });
  failLoading(step, title, reason);
}

/** Only confirms a `<label>.app.<root>` origin, since the CID arrives on the host contract. */
function parseSubdomainLabel(): string | null {
  const hostname = window.location.hostname;

  const appSuffix = `.app.${BASE_DOMAIN}`;
  if (hostname.endsWith(appSuffix)) {
    const label = hostname.slice(0, -appSuffix.length);
    return label || null;
  }

  if (hostname.endsWith('.app.localhost')) {
    const label = hostname.slice(0, -'.app.localhost'.length);
    return label || null;
  }

  return null;
}

/** `null` when the SW does not answer, as an older build does not. */
function querySwVersion(sw: ServiceWorker): Promise<string | null> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, 1_000);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      channel.port1.close();
      const data = event.data as { type?: string; version?: string } | null;
      resolve(data?.type === 'SW_VERSION' && typeof data.version === 'string' ? data.version : null);
    };
    sw.postMessage({ type: 'GET_SW_VERSION' }, [channel.port2]);
  });
}

/** A mismatched SW updates at once and self-promotes, so any reload gets fresh assets. The page reloads on request. */
async function ensureFreshServiceWorker(registration: ServiceWorkerRegistration): Promise<void> {
  const expected = import.meta.env.VITE_COMMIT_SHA;
  if (expected === undefined || expected === '') {
    return;
  }
  const active = registration.active ?? navigator.serviceWorker.controller;
  if (!active) {
    return;
  }
  const actual = await querySwVersion(active);
  if (actual === null || actual === expected) {
    return;
  }
  log.event('Service worker outdated, updating', { flow: 'content', active: actual, expected });
  registration.update().catch((err: unknown) => {
    // A failed download rejects with TypeError, a registration a full reset removed with InvalidStateError.
    if (err instanceof Error && (err.name === 'TypeError' || err.name === 'InvalidStateError')) {
      recordExpected(err, { flow: 'content', step: 'sw_update' });
      return;
    }
    captureException(err, { flow: 'content', step: 'sw_update' });
  });
  showNotification({
    label: 'New version available',
    text: `App was updated. Reload to use the latest version.`,
    dismissMs: 0,
    action: {
      label: 'Reload',
      onClick: () => {
        window.location.reload();
      },
    },
  });
}

/**
 * `waitForFreshController` is for the full reset path: unregistering does not detach the page's current controller,
 * so it waits for a `controllerchange` rather than proceed against the SW it just wiped.
 */
async function registerAppServiceWorker({
  waitForFreshController = false,
}: { waitForFreshController?: boolean } = {}): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    contentLog.warn('[dot.li app] No Service Worker support; continuing without one');
    return;
  }

  try {
    const swUrl = import.meta.env.DEV ? '/src/app-sw.ts' : `${import.meta.env.BASE_URL}app-sw.js`;
    const swScope = import.meta.env.DEV ? '/' : import.meta.env.BASE_URL;
    const registration = await navigator.serviceWorker.register(swUrl, {
      type: 'module',
      scope: swScope,
    });

    if (!waitForFreshController && navigator.serviceWorker.controller) {
      void ensureFreshServiceWorker(registration);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(SANDBOX_ERRORS.SW_NOT_AVAILABLE));
      }, TIMEOUTS.SW_READY);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearTimeout(timeout);
        resolve();
      });
      void navigator.serviceWorker.ready.then(readyRegistration => {
        // In the reset path only a `controllerchange` counts, so prod the new SW to claim clients sooner.
        if (!waitForFreshController && navigator.serviceWorker.controller) {
          clearTimeout(timeout);
          resolve();
        } else if (readyRegistration.active) {
          readyRegistration.active.postMessage({ type: 'SW_CLAIM_EVENT' });
        }
      });
    });

    void ensureFreshServiceWorker(registration);
  } catch (err) {
    contentLog.warn('[dot.li app] Service worker registration failed; continuing without one:', err);
    captureException(err, { flow: 'content', step: 'sw_register', tags: { surface: 'sandbox_main' } });
  }
}

let archiveFailuresHeard = false;

/** Lives for the whole page, since these arrive after the load, often after the dApp replaced this document. */
function listenForArchiveFailures(): void {
  if (archiveFailuresHeard || !('serviceWorker' in navigator)) {
    return;
  }
  archiveFailuresHeard = true;
  navigator.serviceWorker.addEventListener('message', (evt: MessageEvent) => {
    const msg = evt.data as { type?: unknown; stage?: unknown; name?: unknown; message?: unknown } | null;
    if (msg?.type !== 'ARCHIVE_FAILURE') {
      return;
    }
    const err = new Error(typeof msg.message === 'string' ? msg.message : 'unknown archive failure');
    if (typeof msg.name === 'string' && msg.name !== '') {
      err.name = msg.name;
    }
    captureException(err, {
      flow: 'content',
      step: msg.stage === 'restore' ? 'sw_restore' : 'sw_persist',
      tags: { surface: 'app_sw' },
    });
  });
}

/** Before document.write(), or sub-resource requests fall through to nginx's HTML fallback. */
async function storeArchiveInSW(files: ArchiveFiles): Promise<void> {
  const sw = 'serviceWorker' in navigator ? navigator.serviceWorker.controller : null;
  if (!sw) {
    contentLog.warn(
      `[dot.li app] No Service Worker controls the page; ${String(Object.keys(files).length)} archive files will not be served`,
    );
    return;
  }

  const { packed, index } = packArchive(files);

  const archiveReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener('message', handler);
      reject(new Error(SANDBOX_ERRORS.SW_ARCHIVE_NOT_ACKNOWLEDGED));
    }, 10_000);

    const handler = (evt: MessageEvent): void => {
      const msg = evt.data as { type?: string; reason?: string } | null;
      if (msg?.type === 'ARCHIVE_READY') {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('message', handler);
        resolve();
      } else if (msg?.type === 'ARCHIVE_ERROR') {
        // The real cause rather than a timeout, so the retry flow has something to act on.
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('message', handler);
        reject(new Error(`Service worker rejected archive: ${msg.reason ?? 'unknown'}`));
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
  });

  sw.postMessage({ type: 'SET_ARCHIVE', packed, index }, [packed]);

  await archiveReady;
}

/** Inline, since document.write() replaces the page. */
async function maybeInjectSandboxChecker(html: string): Promise<string> {
  if (import.meta.env.VITE_SANDBOX_CHECKER === undefined) {
    return html;
  }
  const { injectSandboxChecker } = await loadSandboxChecker();
  return injectSandboxChecker(html);
}

// So a re-fetch of the same CID in this tab does not prompt again.
const decryptedPasswords = new Map<string, string>();

/** `null` when the data is not encrypted. */
async function decryptIfNeeded(data: Uint8Array, cid: string): Promise<ArchiveFiles | null> {
  if (!isEncrypted(data)) {
    return null;
  }
  log.event(`Content ${cid} is encrypted, asking for the password`, { flow: 'content' });

  dismissHostLoading();

  let password = decryptedPasswords.get(cid);
  let error: string | undefined;
  let attempt = 0;

  // Only an auth-tag mismatch is a wrong password. Any other error is fatal, rather than an endless misleading prompt.
  for (;;) {
    password ??= await showPasswordPrompt(error !== undefined ? { error } : {});
    attempt += 1;
    try {
      const plaintext = await decryptContent(data, password);
      decryptedPasswords.set(cid, password);
      return await parseIpfsResponse(plaintext);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const looksLikeWrongPassword = /invalid tag|auth(entication)? failed|poly1305|chacha/i.test(msg);
      if (!looksLikeWrongPassword) {
        throw err;
      }
      log.event(`Wrong password on attempt ${String(attempt)}, asking again`, { flow: 'content', attempt });
      error = 'Wrong password. Please try again.';
      password = undefined;
    }
  }
}

/**
 * Best-effort, since a page cannot reach `HttpOnly` cookies or, in older Firefox and Safari, enumerate IndexedDB. The
 * reset is opt-in, so a partial wipe is not fatal.
 */
async function purgeSandboxOriginState(): Promise<void> {
  try {
    if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs.map(
          db =>
            new Promise<void>(resolve => {
              if (db.name === undefined || db.name === '') {
                resolve();
                return;
              }
              const req = indexedDB.deleteDatabase(db.name);
              req.onsuccess = (): void => {
                resolve();
              };
              req.onerror = (): void => {
                resolve();
              };
              req.onblocked = (): void => {
                resolve();
              };
            }),
        ),
      );
    }
  } catch (err) {
    log.warn('[dot.li app] IDB purge failed:', err);
  }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (err) {
    log.warn('[dot.li app] CacheStorage purge failed:', err);
  }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch (err) {
    log.warn('[dot.li app] SW unregister failed:', err);
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  } catch (err) {
    log.warn('[dot.li app] localStorage purge failed:', err);
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.clear();
    }
  } catch (err) {
    log.warn('[dot.li app] sessionStorage purge failed:', err);
  }
  // A dApp may have set a cookie on either path.
  try {
    if (document.cookie.length > 0) {
      const expired = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
      for (const entry of document.cookie.split(';')) {
        const name = (entry.split('=')[0] ?? '').trim();
        if (name === '') {
          continue;
        }
        document.cookie = `${name}=; ${expired}; path=/`;
        document.cookie = `${name}=; ${expired}; path=${window.location.pathname}`;
      }
    }
  } catch (err) {
    log.warn('[dot.li app] cookie purge failed:', err);
  }
}

async function main(): Promise<void> {
  const stopApp = m.timer(S.APP_TOTAL);
  performance.mark('dotli:app:start');
  loadStep = 'init';
  log.event('Sandbox load started', { flow: 'content', attempt: runAttempts, ms: sinceStart() });

  // A top-level load has no bridge for account, signing or storage calls, so it fails rather than half-works.
  if (window.self === window.top) {
    // A bookmark or a pasted link: the visitor's doing, not a defect.
    recordExpected(new Error('Sandbox loaded as a top-level page'), { flow: 'content', step: 'contract_top_level' });
    failLoading(
      'contract_top_level',
      'Sandbox URL not supported',
      `Open this dApp through https://${BASE_DOMAIN} — the sandbox origin (${window.location.host}) is not a standalone entry point.`,
    );
    stopApp();
    return;
  }

  // A bare `app.<root>` fails loudly. The CID arrives on the host contract below.
  const subdomainLabel = parseSubdomainLabel();
  if (subdomainLabel === null) {
    failContract(
      'contract_origin',
      'Sandbox URL not supported',
      `This page must load as a dotns app subdomain (e.g. myapp.app.${BASE_DOMAIN}) through dot.li.`,
    );
    stopApp();
    return;
  }

  // The sandbox cannot read the host's localStorage, so every setting arrives in the URL. A missing or invalid value
  // is a hard error, never a silent default. Extra keys are the user's own and pass through.
  const urlParams = new URL(window.location.href).searchParams;
  const parsed = validateSandboxParams(urlParams);
  if (!parsed.ok) {
    if (parsed.recoverable === true) {
      requestHostRerender(parsed.reason);
    } else {
      failContract('contract_params', 'Invalid sandbox URL', parsed.reason);
    }
    stopApp();
    return;
  }
  const { cid, chainBackend, network, resolutionId } = parsed.params;
  // Before setDefaults below, so a failure in between is still attributed to its page load.
  if (resolutionId !== null) {
    setResolutionId(resolutionId);
  }
  const isGateway = chainBackend === 'rpc-gateway';

  setNetworkOverride(network);

  // Before SW registration, so the fresh SW installs cleanly instead of adopting stale state.
  if (parsed.params.fullReset) {
    log.event('Purging sandbox-origin state for a full reset', { flow: 'content' });
    await purgeSandboxOriginState();
  }

  m.setDefaults({
    chain_backend: chainBackend,
    network,
  });

  loadStep = 'sw_register';
  listenForArchiveFailures();
  const stopSw = m.timer(S.APP_SW_REGISTER);
  const swReady = registerAppServiceWorker({
    waitForFreshController: parsed.params.fullReset,
  }).then(v => {
    stopSw();
    return v;
  });
  const fetchChunkPromise = loadFetch();
  const bitswapBridgePromise = isGateway ? null : import('./bitswap-bridge.js');
  // Awaited after the SW is ready, so an early failure must not also reach the global rejection handler.
  void fetchChunkPromise.catch(() => undefined);
  void bitswapBridgePromise?.catch(() => undefined);

  // The SW must control the page before the archive is handed to it.
  await swReady;
  log.event('Service worker ready', {
    flow: 'content',
    controlled: 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null,
    ms: sinceStart(),
  });

  let result: FetchResult;

  if (isGateway) {
    log.event(`Fetching ${cid} via IPFS gateway`, { flow: 'content', ms: sinceStart() });
    showStatus('Fetching via IPFS gateway...');
    loadStep = 'chunk_load';
    const { fetchArchive } = await fetchChunkPromise;
    loadStep = 'content_fetch';
    result = await fetchArchive(cid, showStatus, { useGateway: true });
  } else {
    // Through the host-relayed protocol bridge, so the sandbox runs no libp2p.
    log.event(`Fetching ${cid} via bitswap`, { flow: 'content', chainBackend, ms: sinceStart() });
    showStatus('Fetching via bitswap...');
    if (bitswapBridgePromise === null) {
      throw new Error('Invariant violation: smoldot branch reached but bitswapBridgePromise was not pre-loaded');
    }
    loadStep = 'chunk_load';
    const [{ fetchArchive }, { requestBitswapBlock }] = await Promise.all([fetchChunkPromise, bitswapBridgePromise]);
    loadStep = 'content_fetch';
    result = await fetchArchive(cid, showStatus, {
      bitswapBlockSource: requestBitswapBlock,
    });
  }
  log.event(`Content fetched via ${isGateway ? 'gateway' : 'bitswap'}`, {
    flow: 'content',
    type: result.type,
    bytes: resultBytes(result),
    files: resultFileCount(result),
    ms: sinceStart(),
  });

  if (result.type === 'single') {
    loadStep = 'decrypt';
    const decryptedFiles = await decryptIfNeeded(result.content, cid);
    if (decryptedFiles !== null) {
      result = { type: 'archive', files: decryptedFiles };
      log.event('Content decrypted', {
        flow: 'content',
        bytes: resultBytes(result),
        files: resultFileCount(result),
        ms: sinceStart(),
      });
    }
  }

  // Written into this window, so the host's container bridge reaches the dApp through this iframe.
  let html: string;
  if (result.type === 'single') {
    html = new TextDecoder().decode(result.content);
  } else {
    loadStep = 'sw_store';
    await storeArchiveInSW(result.files);
    log.event('Archive handed to the service worker', {
      flow: 'content',
      files: resultFileCount(result),
      ms: sinceStart(),
    });
    loadStep = 'archive_index';
    const indexHtml = result.files['index.html'] as Uint8Array | undefined;
    if (indexHtml === undefined) {
      throw new Error('Archive missing index.html — cannot render a sandbox without a root document.');
    }
    html = new TextDecoder().decode(indexHtml);
  }

  loadStep = 'render';
  html = await maybeInjectSandboxChecker(html);
  const bytes = resultBytes(result);
  log.event('Writing content into the window', { flow: 'content', bytes, ms: sinceStart() });
  reportSandboxDebug('document_written', resolutionId ?? cid, {
    cid,
    totalMs: sinceStart(),
    bytes,
    fileCount: resultFileCount(result),
  });
  notifyLoadingDone({ outcome: 'loaded' });
  performance.mark('dotli:app:end');
  stopApp();
  stripContractParamsFromUrl();
  document.open();
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional: document.write replaces the page with dApp content to eliminate triple iframe nesting
  document.write(html);
  document.close();
  log.event('Content rendered', { flow: 'content', ms: sinceStart() });
}

/** The frame is going away, not failing. Matched on the message, since it crosses two modules as a plain Error. */
function isTeardownAbort(err: unknown): boolean {
  return err instanceof Error && err.message.includes('bitswap-relay: aborted');
}

// Guards the retry button against overlapping `main()` calls and a user mashing it.
let runInFlight = false;
let runAttempts = 0;
const MAX_RUN_ATTEMPTS = 5;

function run(): void {
  if (runInFlight) {
    log.debug('[dot.li app] run() already in flight; ignoring re-entry');
    return;
  }
  if (runAttempts >= MAX_RUN_ATTEMPTS) {
    contentLog.warn(`[dot.li app] Retry refused after ${String(MAX_RUN_ATTEMPTS)} failed attempts`);
    failLoading(
      'retry_limit',
      'Too many retry attempts',
      `Reached ${String(MAX_RUN_ATTEMPTS)} failed attempts. Reload the page to start over.`,
    );
    return;
  }
  runAttempts += 1;
  runInFlight = true;

  void main()
    .catch((err: unknown) => {
      // Reporting it would file an error every time a user switches product mid-load, burying the real failures.
      if (isTeardownAbort(err)) {
        return;
      }
      const step = failedStepOf(err);
      // Only from the URL param, `unknown` when an error is thrown before validation.
      const params = new URL(window.location.href).searchParams;
      const b = params.get(SANDBOX_CONTRACT_PARAMS.chainBackend);
      const dependency =
        b === 'rpc-gateway'
          ? 'ipfs-gateway'
          : b === 'smoldot-direct' || b === 'smoldot-shared-worker'
            ? 'smoldot-bitswap'
            : 'unknown';
      captureException(err, {
        flow: 'content',
        step,
        tags: { surface: 'sandbox_main', dependency, attempt: String(runAttempts) },
      });
      const raw = err instanceof Error ? err.message : String(err);
      // The gateway path's commonest failure reads as an app bug verbatim, so it gets plain words. A failed dynamic
      // import starts the same way but means a missing chunk, not an unreachable gateway.
      const message =
        dependency === 'ipfs-gateway' && raw.includes('Failed to fetch') && !raw.includes('dynamically imported module')
          ? gatewayUnreachable(endpointHost(getActiveServicesConfig().bulletin.ipfsGateways.at(0)))
          : `${raw} (via ${dependency})`;
      failLoading(step, 'Failed to load content', message, () => {
        showRetryScreen();
        run();
      });
    })
    .finally(() => {
      runInFlight = false;
    });
}

run();
