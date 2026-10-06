// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// App context entry point.
//
// Runs on `<label>.app.dot.li` (the human dotns name). The resolved CID
// arrives on the host-to-sandbox URL contract (`?cid=`). This fetches the
// content over P2P, verifies it against the contract CID, and renders it in
// a sandboxed iframe. No dotns resolution here, no smoldot, no topbar.

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

// Surface chunk-load failures explicitly: capture the original cause to
// Sentry and let the user opt into a reload, instead of reloading silently.
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

// Fetch the toast/modal chunk while the browser is idle, so it is in memory
// before a deploy could make later chunk loads fail.
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

/** Milliseconds since this page started, for progress breadcrumbs. */
function sinceStart(): number {
  return Math.round(performance.now() - T0);
}

/** Warnings and errors of the content load, filed under its flow in the breadcrumb trail. */
const contentLog = log.child({ flow: 'content' });

/**
 * The step of the content load that was running, named the same way in the
 * Sentry capture and in the `failedStep` the host receives.
 *
 * `init` is everything before the Service Worker: the host contract, the
 * full-reset purge, the network override. The `contract_*` steps are the
 * host-to-sandbox contract checks that end the load without throwing. `verify`
 * is never entered: a failure whose error says the content did not match its
 * CID is attributed to it from whichever step fetched or parsed the bytes.
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

/** The step a load failure belongs to. */
function failedStepOf(err: unknown): LoadStep {
  return err instanceof Error && err.name === CONTENT_ERRORS.VERIFICATION ? 'verify' : loadStep;
}

// The sandbox only runs embedded inside the host iframe (`dot.li` iframes
// `<label>.app.dot.li`). Direct or bookmarked loads of the sandbox origin
// are unsupported. They have no container bridge to answer account, signing,
// or storage requests, no trust-shield context, and no unified loading UI.
// `main()` rejects top-level loads with an explicit error. These helpers
// always postMessage to the host parent. There is no "else" branch.

function showStatus(message: string): void {
  window.parent.postMessage({ type: 'dotli:loading-status', message }, '*');
}

function notifyLoadingDone(result: { outcome: 'loaded' } | { outcome: 'failed'; failedStep: LoadStep }): void {
  window.parent.postMessage({ type: 'dotli:loading-status', done: true, ...result }, '*');
}

/** Clear the host overlay for a prompt shown before the content has loaded. */
function dismissHostLoading(): void {
  window.parent.postMessage({ type: 'dotli:loading-status', done: true }, '*');
}

/** Total bytes of the fetched content, which is what the dApp actually weighs. */
function resultBytes(result: FetchResult): number {
  return result.type === 'single'
    ? result.content.byteLength
    : Object.values(result.files).reduce((sum, file) => sum + file.byteLength, 0);
}

function resultFileCount(result: FetchResult): number {
  return result.type === 'single' ? 1 : Object.keys(result.files).length;
}

/**
 * Report a sandbox-origin debug event to the host debug bus.
 *
 * The sandbox runs on its own origin and cannot reach `emitDotliDebugEvent`,
 * so the host relays anything shaped like this whose layer is `sandbox`. See
 * `listenForSandboxDebugEvents` in `apps/host/src/main.ts`. Sent
 * unconditionally: the sandbox cannot see whether the panel is open, and the
 * host drops the message when it is not.
 */
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

/**
 * Remove host-to-sandbox contract keys from `window.location` so the dApp
 * has only the user's own query params.
 */
function stripContractParamsFromUrl(): void {
  const cleaned = new URL(window.location.href);
  for (const key of Object.values(SANDBOX_CONTRACT_PARAMS)) {
    cleaned.searchParams.delete(key);
  }
  history.replaceState(null, '', cleaned.toString());
}

/**
 * Ask the host shell to rebuild this iframe with a fresh contract URL.
 *
 * `stripContractParamsFromUrl` removes the contract params once boot
 * succeeds, so a later reload of this window (a dApp calling
 * `location.reload()`, a browser restoring a crashed frame) boots with no
 * `?cid=`. The host still tracks the rendered label and resolved CID and
 * can re-render the iframe with the exact params it last threaded. If the
 * host does not tear this iframe down within the timeout (it no longer
 * tracks a product, or its rate guard tripped) fall back to the hard
 * contract error this path showed before recovery existed.
 */
function requestHostRerender(reason: string): void {
  log.event('Asking the host to re-render the sandbox', { flow: 'content', reason });
  showStatus('Restoring app...');
  window.parent.postMessage({ type: 'dotli:sandbox-recover' }, '*');
  window.setTimeout(() => {
    failContract('contract_rerender', 'Invalid sandbox URL', reason);
  }, TIMEOUTS.SANDBOX_RECOVER);
}

/**
 * Render the sandbox-local error page AND tell the host shell its loading
 * overlay is finished. Without the parent notify, the host's loading screen
 * (`#app-loading`) stays visible (the host keeps it around as a sibling of the
 * sandbox iframe so progress updates can land) and the two screens stack
 * visibly: the error title plus the still-ticking progress bar from above.
 */
function failLoading(step: LoadStep, ...args: Parameters<typeof showError>): void {
  notifyLoadingDone({ outcome: 'failed', failedStep: step });
  showError(...args);
}

/**
 * End the load on a broken host-to-sandbox contract, and report it: the host
 * built a URL this sandbox cannot use, which no visitor can cause or fix.
 */
function failContract(step: LoadStep, title: string, reason: string): void {
  const err = new Error(`${title}: ${reason}`);
  err.name = 'SandboxContractError';
  captureException(err, { flow: 'content', step, tags: { surface: 'sandbox_main' } });
  failLoading(step, title, reason);
}

/**
 * Extract the app subdomain label (the dotns name) from the hostname.
 *
 * The CID no longer lives in the origin (it arrives on the host contract), so
 * this only confirms we are on a real `<label>.app.<root>` origin. Returns
 * `null` for a bare `app.<root>` or any non-`*.app.*` host.
 */
function parseSubdomainLabel(): string | null {
  const hostname = window.location.hostname;

  // Production: <label>.app.{BASE_DOMAIN}
  const appSuffix = `.app.${BASE_DOMAIN}`;
  if (hostname.endsWith(appSuffix)) {
    const label = hostname.slice(0, -appSuffix.length);
    return label || null;
  }

  // Local dev: <label>.app.localhost
  if (hostname.endsWith('.app.localhost')) {
    const label = hostname.slice(0, -'.app.localhost'.length);
    return label || null;
  }

  return null;
}

/**
 * Ask an active Service Worker for its baked-in version tag.
 * Resolves `null` if the SW doesn't answer (older build, comms error, timeout).
 */
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

/**
 * Check whether the active SW's build matches the page's build. On mismatch
 * fetch the new SW right away, which self-promotes via `skipWaiting()` and
 * `clients.claim()`, so any reload gets fresh assets. The page itself is not
 * reloaded: a notification offers it, and the user decides.
 */
async function ensureFreshServiceWorker(registration: ServiceWorkerRegistration): Promise<void> {
  const expected = import.meta.env.VITE_COMMIT_SHA;
  if (expected === undefined || expected === '') {
    return; // dev build, no version to compare against
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
    // The worker script failing to download (offline, a flaky connection)
    // rejects with a TypeError, and a registration a full reset already
    // removed with InvalidStateError. Neither is a defect in this build.
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
 * Register the app Service Worker for archive serving.
 *
 * `waitForFreshController` is the escape hatch for the `fullReset=1` path:
 * after `purgeSandboxOriginState()` unregisters every SW, the browser may
 * still report a stale `navigator.serviceWorker.controller` for the current
 * document (unregister doesn't detach the already-attached controller from
 * an in-flight page). If we short-circuit on that stale controller we'd
 * proceed against the SW we just tried to wipe. In the reset path we
 * always wait for a `controllerchange` (or for the freshly-registered SW
 * to claim clients in response to `SW_CLAIM_EVENT`) before returning.
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
        // In the reset path we explicitly ignore the current controller.
        // Only a `controllerchange` counts as "fresh". Prod the new SW to
        // claim clients so the controllerchange arrives quickly.
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

/**
 * Report the Service Worker's failures to keep the archive across its
 * restarts. They arrive after the load has finished, often after the dApp
 * has replaced this document, so the listener lives for the whole page.
 */
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

/**
 * Store archive files in the Service Worker so it can serve sub-resources.
 * Must be called before document.write() for multi-file archives in relay mode,
 * otherwise CSS/JS requests fall through to nginx which returns the HTML fallback.
 */
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
        // The SW rejected the payload (malformed index or IDB persist
        // failure). Surface the real cause instead of waiting for the
        // timeout, so the page retry flow has something to act on.
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

/**
 * Optionally inject the sandbox checker script into HTML for relay mode.
 * In relay mode, document.write() replaces the page, so we must inject
 * the checker inline.
 */
async function maybeInjectSandboxChecker(html: string): Promise<string> {
  if (import.meta.env.VITE_SANDBOX_CHECKER === undefined) {
    return html;
  }
  const { injectSandboxChecker } = await loadSandboxChecker();
  return injectSandboxChecker(html);
}

// Session-scoped decryption key cache: once a user decrypts a CID in this tab,
// we store the password so a re-fetch of the same CID in the same session
// doesn't re-prompt.
const decryptedPasswords = new Map<string, string>();

/**
 * If `data` is an encrypted blob, prompt for a password, decrypt, and parse.
 * Returns null if the data is not encrypted (caller should handle normally).
 */
async function decryptIfNeeded(data: Uint8Array, cid: string): Promise<ArchiveFiles | null> {
  if (!isEncrypted(data)) {
    return null;
  }
  log.event(`Content ${cid} is encrypted, asking for the password`, { flow: 'content' });

  // Tell the host to dismiss its loading overlay so the password prompt
  // isn't covered by the shell's spinner.
  dismissHostLoading();

  // Re-use password from this session if available
  let password = decryptedPasswords.get(cid);
  let error: string | undefined;
  let attempt = 0;

  // Only treat ChaCha20-Poly1305 auth-tag mismatch as "wrong password". Any
  // other decryption error (corrupted ciphertext, library bug) is fatal.
  // Surface the real cause instead of looping infinitely with a misleading
  // "Wrong password" prompt.
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
 * Wipe every piece of sandbox-origin state before init. Triggered by the
 * `fullReset=1` URL param the host sets on the first load after "Save &
 * Apply".
 *
 * Clears, in order:
 *   - IndexedDB   (all databases enumerable via `indexedDB.databases()`)
 *   - CacheStorage (every named cache the document can see)
 *   - ServiceWorker registrations (next `registerAppServiceWorker()` call
 *     installs a fresh one against empty caches)
 *   - localStorage / sessionStorage (cleared to the empty object)
 *   - JS-visible cookies (expired on path=/ and on the current path)
 *
 * Best-effort across the board. Some surfaces cannot be wiped from a
 * page context:
 *   - Firefox < 126 and Safari < 17 don't expose `indexedDB.databases()`,
 *     so IDB stores opened before this page load cannot be enumerated.
 *   - `HttpOnly` cookies are invisible to `document.cookie` and therefore
 *     unreachable from JS. Clearing those requires server-side headers.
 * The user still gets a near-clean baseline. Surviving state is logged
 * as a warning, not treated as fatal, because the reset is opt-in and
 * the worst case is a partial wipe.
 */
async function purgeSandboxOriginState(): Promise<void> {
  // IDB
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
  // CacheStorage (the Cache API). The archive itself lives only in the SW's
  // memory now, so there's nothing archive-related here to clear.
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (err) {
    log.warn('[dot.li app] CacheStorage purge failed:', err);
  }
  // Service workers: unregister so the next registerAppServiceWorker() call
  // installs a fresh one against empty caches.
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch (err) {
    log.warn('[dot.li app] SW unregister failed:', err);
  }
  // localStorage and sessionStorage. The `purge…State` name promises a full
  // wipe, so these must be cleared too. Otherwise a dApp that stashed
  // preferences or tokens here would survive the reset.
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
  // Cookies visible to `document.cookie`. `HttpOnly` cookies are out of
  // reach from JS, as documented above. Expire on both `/` and the current
  // path since a dApp may have set the cookie on either.
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

  // The sandbox is host-managed only. It must run as an iframe child of
  // the dot.li shell. A top-level load here has no bridge to answer
  // account/signing/storage calls, no shield/topbar context, and no
  // unified loading UI. Fail loudly instead of degrading into a broken
  // half-page. Users arriving via a bookmark are pointed back at dot.li.
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

  // The origin is now the dotns label (`<label>.app.<root>`), not the CID.
  // We still require a subdomain so a bare `app.<root>` top load fails
  // loudly. The actual CID arrives on the host contract below.
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

  // The sandbox lives on `<label>.app.dot.li` and cannot read the host's
  // localStorage, so every user-chosen axis (and the resolved CID) must
  // arrive via URL param. The validator in
  // `@dotli/config/host-sandbox-contract` is the single source of truth
  // for the schema and accepted values across host and sandbox. Missing
  // or invalid contract values are a hard error. There is no silent
  // default. Extra keys are user query params and pass through.
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
  // Before the setDefaults below, so a failure between here and there is still
  // attributable to the page load that caused it.
  if (resolutionId !== null) {
    setResolutionId(resolutionId);
  }
  const isGateway = chainBackend === 'rpc-gateway';

  setNetworkOverride(network);

  // Full-reset signal from the host settings popover: wipe sandbox-origin
  // state (IDB, CacheStorage, SW registrations) before the normal init
  // flow so the user gets a truly clean baseline across every origin.
  // Runs before SW registration so the fresh SW installs cleanly instead
  // of adopting stale state.
  if (parsed.params.fullReset) {
    log.event('Purging sandbox-origin state for a full reset', { flow: 'content' });
    await purgeSandboxOriginState();
  }

  // Propagate the chainBackend and network choices into every metric emitted
  // from the sandbox so dashboards can slice on them.
  m.setDefaults({
    chain_backend: chainBackend,
    network,
  });

  // Register the SW and pre-load chunks in parallel.
  // After a fullReset the existing `navigator.serviceWorker.controller`
  // is the SW we just unregistered, so force the registration path to wait
  // for a fresh controller rather than adopting that stale one.
  loadStep = 'sw_register';
  listenForArchiveFailures();
  const stopSw = m.timer(S.APP_SW_REGISTER);
  const swReady = registerAppServiceWorker({
    waitForFreshController: parsed.params.fullReset,
  }).then(v => {
    stopSw();
    return v;
  });
  // Pre-load the fetch chunk. Gateway mode only
  // needs `fetchViaGateway` (small). The smoldot backends additionally
  // need the bitswap-bridge module to call into the protocol iframe.
  const fetchChunkPromise = loadFetch();
  const bitswapBridgePromise = isGateway ? null : import('./bitswap-bridge.js');
  // Awaited only after the SW is ready, so a chunk that fails first would
  // also reach the global rejection handler and file a second issue.
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
    // rpc-gateway mode: HTTPS fetch from a trusted IPFS gateway.
    log.event(`Fetching ${cid} via IPFS gateway`, { flow: 'content', ms: sinceStart() });
    showStatus('Fetching via IPFS gateway...');
    loadStep = 'chunk_load';
    const { fetchArchive } = await fetchChunkPromise;
    loadStep = 'content_fetch';
    result = await fetchArchive(cid, showStatus, { useGateway: true });
  } else {
    // smoldot-direct / smoldot-shared-worker: fetch via smoldot's `bitswap_v1_get`
    // through the host-relayed protocol bridge. No libp2p in the sandbox.
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

  // Decrypt if the fetched content is an encrypted blob
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

  // Write the dApp content directly into this window so it occupies the
  // APP iframe. The HOST's container bridge communicates with this iframe
  // through window.top and iframe.contentWindow.
  let html: string;
  if (result.type === 'single') {
    html = new TextDecoder().decode(result.content);
  } else {
    // For multi-file archives, store files in the SW so it can serve
    // sub-resources (CSS, JS, fonts) when the browser loads them.
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

// The retry button exists so a user can re-trigger a failed init after
// fixing something out-of-band (e.g. toggling a flag). It is NOT an
// automatic retry, only a click path. We still guard against runaway
// recursion if the user mashes the button and against overlapping
// `main()` calls (two invocations would race on each other).
/**
 * A rejection that means "this frame is going away", not "this load failed".
 *
 * The sandbox bridge rejects its pending block fetches on `pagehide` so the
 * awaiting archive walk unwinds instead of hanging. Matched on the message
 * because the rejection crosses two module boundaries as a plain Error.
 */
function isTeardownAbort(err: unknown): boolean {
  return err instanceof Error && err.message.includes('bitswap-relay: aborted');
}

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
      // A frame torn down mid-load aborts its own fetches, so this rejection
      // is the teardown working rather than a load that failed. Reporting it
      // would file a Sentry error and paint an error screen every time a user
      // switches product while content is still arriving, which buries the
      // real failures this telemetry exists to surface.
      if (isTeardownAbort(err)) {
        return;
      }
      const step = failedStepOf(err);
      // Surface before rendering so Sentry sees every failure. Attribute
      // strictly from the explicit `chainBackend` URL param. Tag `unknown`
      // when missing rather than guessing (the missing-param path is
      // already a hard error from `main()`, but a thrown error before
      // that validation also lands here).
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
      // `TypeError: Failed to fetch` is all the browser says when it could not
      // open the connection, and it is the single most common way the gateway
      // path fails. Passed through verbatim it reads as a bug in the app, so
      // the one case that has a plain-language equivalent gets it.
      //
      // The dynamic-import failure has to be excluded explicitly: its message
      // starts with the same four words but means a missing app chunk, not an
      // unreachable gateway. Blaming the gateway for a rotated asset sends the
      // visitor after the wrong thing entirely.
      const message =
        dependency === 'ipfs-gateway' && raw.includes('Failed to fetch') && !raw.includes('dynamically imported module')
          ? gatewayUnreachable(endpointHost(getActiveServicesConfig().bulletin.ipfsGateways.at(0)))
          : `${raw} (via ${dependency})`;
      failLoading(step, 'Failed to load content', message, () => {
        // Restore the loading UI and re-run main
        showRetryScreen();
        run();
      });
    })
    .finally(() => {
      runInFlight = false;
    });
}

run();
