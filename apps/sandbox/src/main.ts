// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// App context entry point.
//
// Runs on `<label>.app.dot.li` (the human dotns name). The resolved CID
// arrives on the host-to-sandbox URL contract (`?cid=`). This fetches the
// content over P2P, verifies it against the contract CID, and renders it in
// a sandboxed iframe. No dotns resolution here, no smoldot, no topbar.

import "@dotli/ui/styles.css";
import {
  initSentry,
  installGlobalErrorHandlers,
  captureException,
} from "@dotli/metrics/sentry";
import { showNotification } from "@dotli/ui/notification";

// Surface chunk-load failures explicitly: capture the original cause to
// Sentry and let the user opt into a reload, instead of reloading silently.
window.addEventListener("vite:preloadError", (event) => {
  const evt = event as unknown as { payload?: unknown };
  captureException(evt.payload ?? new Error("vite:preloadError"), {
    kind: "chunk_preload_error",
  });
  showNotification({
    label: "Asset failed to load",
    text: "A new version may have been deployed. Reload to get the latest.",
    dismissMs: 0,
    action: {
      label: "Reload",
      onClick: () => {
        window.location.reload();
      },
    },
  });
});
import { packArchive, type ArchiveFiles } from "@dotli/content/archive";
import type { FetchResult } from "@dotli/content/fetch";
import { isEncrypted, decryptContent } from "@dotli/content/decrypt";
import { showError } from "@dotli/ui/ui";
import { showPasswordPrompt } from "@dotli/ui/password-prompt";
import { TIMEOUTS, BASE_DOMAIN } from "@dotli/config/config";
import {
  SANDBOX_CONTRACT_PARAMS,
  validateSandboxParams,
} from "@dotli/config/host-sandbox-contract";
import { setNetworkOverride } from "@dotli/config/network";
import { elapsed } from "@dotli/shared/perf";
import { log } from "@dotli/shared/log";
import { parseIpfsResponse } from "@dotli/content/archive";

initSentry("sandbox");
installGlobalErrorHandlers("sandbox");

import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";

const T0 = performance.now();

// The sandbox only runs embedded inside the host iframe (`dot.li` iframes
// `<label>.app.dot.li`). Direct or bookmarked loads of the sandbox origin
// are unsupported. They have no container bridge to answer account, signing,
// or storage requests, no trust-shield context, and no unified loading UI.
// `main()` rejects top-level loads with an explicit error. These helpers
// always postMessage to the host parent. There is no "else" branch.

function showStatus(message: string): void {
  window.parent.postMessage({ type: "dotli:loading-status", message }, "*");
}

function notifyLoadingDone(): void {
  window.parent.postMessage({ type: "dotli:loading-status", done: true }, "*");
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
  history.replaceState(null, "", cleaned.toString());
}

/**
 * Render the sandbox-local error page AND tell the host shell its loading
 * overlay is finished. Without the parent notify, the host's `.loading`
 * stays visible (the host keeps it around as a sibling of the sandbox
 * iframe so progress updates can land) and the two screens stack visibly:
 * the error title plus the still-ticking progress bar from above.
 */
function failLoading(...args: Parameters<typeof showError>): void {
  notifyLoadingDone();
  showError(...args);
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
  if (hostname.endsWith(".app.localhost")) {
    const label = hostname.slice(0, -".app.localhost".length);
    return label || null;
  }

  return null;
}

/**
 * Check if the Service Worker has a cached archive for this CID.
 */
async function getCachedArchive(
  domain: string,
  cid: string,
  contentBackend: string,
): Promise<ArchiveFiles | null> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    return null;
  }

  return new Promise<ArchiveFiles | null>((resolve) => {
    const timeout = setTimeout(() => {
      resolve(null);
    }, TIMEOUTS.SW_CACHE_LOOKUP);
    const channel = new MessageChannel();

    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timeout);
      const msg = event.data as {
        found?: boolean;
        cid?: string;
        contentBackend?: string;
        files?: Record<string, ArrayBuffer | Uint8Array> | null;
      };
      // Only return a cache hit if the entry was populated under the same
      // content backend the user has selected now. A gateway-fetched archive
      // must not satisfy a P2P-mode request and vice versa.
      if (
        msg.found === true &&
        msg.cid === cid &&
        msg.contentBackend === contentBackend &&
        msg.files !== undefined &&
        msg.files !== null
      ) {
        const raw = msg.files;
        const files: ArchiveFiles = {};
        for (const [path, data] of Object.entries(raw)) {
          files[path] =
            data instanceof Uint8Array ? data : new Uint8Array(data);
        }
        resolve(files);
      } else {
        resolve(null);
      }
    };

    controller.postMessage(
      { type: "SW_CACHE_LOOKUP_EVENT", domain, contentBackend },
      [channel.port2],
    );
  });
}

/**
 * Ask an active Service Worker for its baked-in version tag.
 * Resolves `null` if the SW doesn't answer (older build, comms error, timeout).
 */
function querySwVersion(sw: ServiceWorker): Promise<string | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, 1_000);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      channel.port1.close();
      const data = event.data as { type?: string; version?: string } | null;
      resolve(
        data?.type === "SW_VERSION" && typeof data.version === "string"
          ? data.version
          : null,
      );
    };
    sw.postMessage({ type: "GET_SW_VERSION" }, [channel.port2]);
  });
}

/**
 * Check whether the active SW's build matches the page's build. On mismatch
 * surface a notification with a "Reload" action, and the user decides whether
 * to take it. NO automatic reload: silently triggering `update()` followed by
 * a reload on `controllerchange` would override the user's current session
 * without consent.
 */
async function ensureFreshServiceWorker(
  registration: ServiceWorkerRegistration,
): Promise<void> {
  const expected = import.meta.env.VITE_COMMIT_SHA as string | undefined;
  if (expected === undefined || expected === "") {
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
  log.warn(
    `[dot.li app] SW version mismatch (active=${actual}, expected=${expected}); prompting user`,
  );
  showNotification({
    label: "New version available",
    text: `App was updated. Reload to use the latest version.`,
    dismissMs: 0,
    action: {
      label: "Reload",
      onClick: () => {
        // User-driven update then reload. The SW self-promotes via
        // `skipWaiting()` and `clients.claim()`. When the controller flips,
        // reload to pick up fresh assets.
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => {
            window.location.reload();
          },
          { once: true },
        );
        registration.update().catch((err: unknown) => {
          captureException(err, { kind: "sw_update_failed" });
          log.error("[dot.li app] SW update() failed:", err);
        });
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
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    const swUrl = import.meta.env.DEV
      ? "/src/app-sw.ts"
      : `${import.meta.env.BASE_URL}app-sw.js`;
    const swScope = import.meta.env.DEV ? "/" : import.meta.env.BASE_URL;
    const registration = await navigator.serviceWorker.register(swUrl, {
      type: "module",
      scope: swScope,
    });

    if (!waitForFreshController && navigator.serviceWorker.controller) {
      void ensureFreshServiceWorker(registration);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Service Worker not available after 10s"));
      }, TIMEOUTS.SW_READY);
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        clearTimeout(timeout);
        resolve();
      });
      void navigator.serviceWorker.ready.then((readyRegistration) => {
        // In the reset path we explicitly ignore the current controller.
        // Only a `controllerchange` counts as "fresh". Prod the new SW to
        // claim clients so the controllerchange arrives quickly.
        if (!waitForFreshController && navigator.serviceWorker.controller) {
          clearTimeout(timeout);
          resolve();
        } else if (readyRegistration.active) {
          readyRegistration.active.postMessage({ type: "SW_CLAIM_EVENT" });
        }
      });
    });

    void ensureFreshServiceWorker(registration);
  } catch (err) {
    log.warn("[dot.li app] Service worker registration failed:", err);
  }
}

/**
 * Store archive files in the Service Worker so it can serve sub-resources.
 * Must be called before document.write() for multi-file archives in relay mode,
 * otherwise CSS/JS requests fall through to nginx which returns the HTML fallback.
 */
async function storeArchiveInSW(
  files: ArchiveFiles,
  domain: string,
  cid: string,
  contentBackend: string,
): Promise<void> {
  const sw = navigator.serviceWorker.controller;
  if (!sw) {
    return;
  }

  const { packed, index } = packArchive(files);

  const archiveReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener("message", handler);
      reject(
        new Error("Service worker did not acknowledge archive within 10s"),
      );
    }, 10_000);

    const handler = (evt: MessageEvent): void => {
      const msg = evt.data as { type?: string; reason?: string } | null;
      if (msg?.type === "ARCHIVE_READY") {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener("message", handler);
        resolve();
      } else if (msg?.type === "ARCHIVE_ERROR") {
        // The SW rejected the payload (malformed index or IDB persist
        // failure). Surface the real cause instead of waiting for the
        // timeout, so the page retry flow has something to act on.
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener("message", handler);
        reject(
          new Error(
            `Service worker rejected archive: ${msg.reason ?? "unknown"}`,
          ),
        );
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
  });

  // Tag the stored archive with the backend it was fetched under so future
  // cache lookups can verify the backend matches the user's current setting.
  sw.postMessage(
    { type: "SET_ARCHIVE", packed, index, domain, cid, contentBackend },
    [packed],
  );

  await archiveReady;
}

/**
 * Optionally inject the sandbox checker script into HTML for relay mode.
 * In relay mode, document.write() replaces the page, so we must inject
 * the checker inline.
 */
async function maybeInjectSandboxChecker(html: string): Promise<string> {
  if (
    (import.meta.env.VITE_SANDBOX_CHECKER as string | undefined) === undefined
  ) {
    return html;
  }
  const { injectSandboxChecker } =
    await import("@dotli/sandbox-checker/sandbox-checker");
  return injectSandboxChecker(html);
}

// Session-scoped decryption key cache: once a user decrypts a CID in this tab,
// we store the password so SW-cache hits don't re-prompt.
const decryptedPasswords = new Map<string, string>();

/**
 * If `data` is an encrypted blob, prompt for a password, decrypt, and parse.
 * Returns null if the data is not encrypted (caller should handle normally).
 */
async function decryptIfNeeded(
  data: Uint8Array,
  cid: string,
): Promise<ArchiveFiles | null> {
  if (!isEncrypted(data)) {
    return null;
  }
  log.warn(`[dot.li app] Content is encrypted, prompting for password...`);

  // Tell the host to dismiss its loading overlay so the password prompt
  // isn't covered by the shell's spinner.
  notifyLoadingDone();

  // Re-use password from this session if available
  let password = decryptedPasswords.get(cid);
  let error: string | undefined;

  // Only treat ChaCha20-Poly1305 auth-tag mismatch as "wrong password". Any
  // other decryption error (corrupted ciphertext, library bug) is fatal.
  // Surface the real cause instead of looping infinitely with a misleading
  // "Wrong password" prompt.
  for (;;) {
    password ??= await showPasswordPrompt({ error });
    try {
      const plaintext = await decryptContent(data, password);
      decryptedPasswords.set(cid, password);
      return await parseIpfsResponse(plaintext);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const looksLikeWrongPassword =
        /invalid tag|auth(entication)? failed|poly1305|chacha/i.test(msg);
      if (!looksLikeWrongPassword) {
        throw err;
      }
      error = "Wrong password. Please try again.";
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
    if (
      typeof indexedDB !== "undefined" &&
      typeof indexedDB.databases === "function"
    ) {
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs.map(
          (db) =>
            new Promise<void>((resolve) => {
              if (db.name === undefined || db.name === "") {
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
    log.warn("[dot.li app] IDB purge failed:", err);
  }
  // CacheStorage (the Cache API, not the SW archive which lives in IDB)
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (err) {
    log.warn("[dot.li app] CacheStorage purge failed:", err);
  }
  // Service workers: unregister so the next registerAppServiceWorker() call
  // installs a fresh one against empty caches.
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch (err) {
    log.warn("[dot.li app] SW unregister failed:", err);
  }
  // localStorage and sessionStorage. The `purge…State` name promises a full
  // wipe, so these must be cleared too. Otherwise a dApp that stashed
  // preferences or tokens here would survive the reset.
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.clear();
    }
  } catch (err) {
    log.warn("[dot.li app] localStorage purge failed:", err);
  }
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.clear();
    }
  } catch (err) {
    log.warn("[dot.li app] sessionStorage purge failed:", err);
  }
  // Cookies visible to `document.cookie`. `HttpOnly` cookies are out of
  // reach from JS, as documented above. Expire on both `/` and the current
  // path since a dApp may have set the cookie on either.
  try {
    if (document.cookie.length > 0) {
      const expired = "expires=Thu, 01 Jan 1970 00:00:00 GMT";
      for (const entry of document.cookie.split(";")) {
        const name = entry.split("=")[0].trim();
        if (name === "") {
          continue;
        }
        document.cookie = `${name}=; ${expired}; path=/`;
        document.cookie = `${name}=; ${expired}; path=${window.location.pathname}`;
      }
    }
  } catch (err) {
    log.warn("[dot.li app] cookie purge failed:", err);
  }
}

async function main(): Promise<void> {
  const stopApp = m.timer(S.APP_TOTAL);
  performance.mark("dotli:app:start");
  log.warn(`[dot.li app] main() started (${elapsed(T0)})`);

  // The sandbox is host-managed only. It must run as an iframe child of
  // the dot.li shell. A top-level load here has no bridge to answer
  // account/signing/storage calls, no shield/topbar context, and no
  // unified loading UI. Fail loudly instead of degrading into a broken
  // half-page. Users arriving via a bookmark are pointed back at dot.li.
  if (window.self === window.top) {
    failLoading(
      "Sandbox URL not supported",
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
    failLoading(
      "Sandbox URL not supported",
      `This page must load as a dotns app subdomain (e.g. myapp.app.${BASE_DOMAIN}) through dot.li.`,
    );
    stopApp();
    return;
  }

  showStatus("Loading content...");

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
    failLoading("Invalid sandbox URL", parsed.reason);
    stopApp();
    return;
  }
  const { cid, chainBackend, network, skipArchiveCache } = parsed.params;
  const isGateway = chainBackend === "rpc-gateway";

  setNetworkOverride(network);

  // Full-reset signal from the host settings popover: wipe sandbox-origin
  // state (IDB, CacheStorage, SW registrations) before the normal init
  // flow so the user gets a truly clean baseline across every origin.
  // Runs before SW registration so the fresh SW installs cleanly instead
  // of adopting stale state.
  if (parsed.params.fullReset) {
    log.warn("[dot.li app] fullReset=1 → purging sandbox-origin state");
    await purgeSandboxOriginState();
  }

  // Propagate the chainBackend and network choices into every metric emitted
  // from the sandbox so dashboards can slice on them.
  m.setDefaults({
    skip_archive_cache: String(skipArchiveCache),
    chain_backend: chainBackend,
    network,
  });

  // Register the SW and pre-load chunks in parallel.
  // After a fullReset the existing `navigator.serviceWorker.controller`
  // is the SW we just unregistered, so force the registration path to wait
  // for a fresh controller rather than adopting that stale one.
  const stopSw = m.timer(S.APP_SW_REGISTER);
  const swReady = registerAppServiceWorker({
    waitForFreshController: parsed.params.fullReset,
  }).then((v) => {
    stopSw();
    return v;
  });
  // Pre-load the fetch chunk for the cache-miss path. Gateway mode only
  // needs `fetchViaGateway` (small). The smoldot backends additionally
  // need the bitswap-bridge module to call into the protocol iframe.
  const fetchChunkPromise = import("@dotli/content/fetch");
  const bitswapBridgePromise = isGateway ? null : import("./bitswap-bridge");

  // Wait for SW before cache check
  await swReady;
  log.warn(`[dot.li app] SW ready (${elapsed(T0)})`);

  // Check SW cache first (skip if user disabled content cache). The cache
  // lookup is keyed by (cid, chainBackend) so a stale gateway-fetched archive
  // cannot satisfy a smoldot-mode request and vice versa.
  const cachedFiles = skipArchiveCache
    ? null
    : await getCachedArchive(cid, cid, chainBackend);
  if (cachedFiles) {
    log.warn(`[dot.li app] SW archive cache HIT (${elapsed(T0)})`);

    // Extract index.html and write it directly into this window so it
    // occupies the APP iframe. An archive without index.html is invalid,
    // so surface it instead of silently falling through to a no-op render.
    const indexHtml = cachedFiles["index.html"] as Uint8Array | undefined;
    if (indexHtml === undefined) {
      throw new Error(
        "Archive cache hit missing index.html — cannot render a sandbox without a root document.",
      );
    }
    // For multi-file archives, store files in the SW so it can serve
    // sub-resources (CSS, JS, fonts) when the browser loads them.
    if (Object.keys(cachedFiles).length > 1) {
      await storeArchiveInSW(cachedFiles, cid, cid, chainBackend);
      log.warn(`[dot.li app] archive stored in SW (${elapsed(T0)})`);
    }
    let html = new TextDecoder().decode(indexHtml);
    html = await maybeInjectSandboxChecker(html);
    log.warn(
      `[dot.li app] writing cached content into window (${elapsed(T0)})`,
    );
    notifyLoadingDone();
    performance.mark("dotli:app:end");
    stopApp();
    stripContractParamsFromUrl();
    document.open();
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional: document.write replaces the page with dApp content to eliminate triple iframe nesting
    document.write(html);
    document.close();
    return;
  }

  let result: FetchResult;

  if (isGateway) {
    // rpc-gateway mode: HTTPS fetch from a trusted IPFS gateway.
    log.warn(
      `[dot.li app] SW archive cache MISS — rpc-gateway mode, using IPFS gateway (${elapsed(T0)})`,
    );
    showStatus("Fetching via IPFS gateway...");
    const { fetchArchive } = await fetchChunkPromise;
    result = await fetchArchive(cid, showStatus, { useGateway: true });
  } else {
    // smoldot-direct / smoldot-shared-worker: fetch via smoldot's `bitswap_v1_get`
    // through the host-relayed protocol bridge. No libp2p in the sandbox.
    log.warn(
      `[dot.li app] SW archive cache MISS — ${chainBackend} (bitswap) (${elapsed(T0)})`,
    );
    showStatus("Fetching via bitswap...");
    if (bitswapBridgePromise === null) {
      throw new Error(
        "Invariant violation: smoldot branch reached but bitswapBridgePromise was not pre-loaded",
      );
    }
    const [{ fetchArchive }, { requestBitswapBlock }] = await Promise.all([
      fetchChunkPromise,
      bitswapBridgePromise,
    ]);
    result = await fetchArchive(cid, showStatus, {
      bitswapBlockSource: requestBitswapBlock,
    });
  }
  log.warn(`[dot.li app] Content fetched → ${result.type} (${elapsed(T0)})`);

  // Decrypt if the fetched content is an encrypted blob
  if (result.type === "single") {
    const decryptedFiles = await decryptIfNeeded(result.content, cid);
    if (decryptedFiles !== null) {
      log.warn(`[dot.li app] Content decrypted (${elapsed(T0)})`);
      result = { type: "archive", files: decryptedFiles };
    }
  }

  // Write the dApp content directly into this window so it occupies the
  // APP iframe. The HOST's container bridge communicates with this iframe
  // through window.top and iframe.contentWindow.
  let html: string;
  if (result.type === "single") {
    html = new TextDecoder().decode(result.content);
  } else {
    // For multi-file archives, store files in the SW so it can serve
    // sub-resources (CSS, JS, fonts) when the browser loads them.
    await storeArchiveInSW(result.files, cid, cid, chainBackend);
    log.warn(`[dot.li app] archive stored in SW (${elapsed(T0)})`);
    const indexHtml = result.files["index.html"] as Uint8Array | undefined;
    if (indexHtml === undefined) {
      throw new Error(
        "Archive missing index.html — cannot render a sandbox without a root document.",
      );
    }
    html = new TextDecoder().decode(indexHtml);
  }

  html = await maybeInjectSandboxChecker(html);
  log.warn(`[dot.li app] writing content into window (${elapsed(T0)})`);
  notifyLoadingDone();
  performance.mark("dotli:app:end");
  stopApp();
  stripContractParamsFromUrl();
  document.open();
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional: document.write replaces the page with dApp content to eliminate triple iframe nesting
  document.write(html);
  document.close();
  log.warn(`[dot.li app] Done (${elapsed(T0)})`);
}

// The retry button exists so a user can re-trigger a failed init after
// fixing something out-of-band (e.g. toggling a flag). It is NOT an
// automatic retry, only a click path. We still guard against runaway
// recursion if the user mashes the button and against overlapping
// `main()` calls (two invocations would race on each other).
let runInFlight = false;
let runAttempts = 0;
const MAX_RUN_ATTEMPTS = 5;

function run(): void {
  if (runInFlight) {
    log.warn("[dot.li app] run() already in flight; ignoring re-entry");
    return;
  }
  if (runAttempts >= MAX_RUN_ATTEMPTS) {
    failLoading(
      "Too many retry attempts",
      `Reached ${String(MAX_RUN_ATTEMPTS)} failed attempts. Reload the page to start over.`,
    );
    return;
  }
  runAttempts += 1;
  runInFlight = true;

  void main()
    .catch((err: unknown) => {
      // Surface before rendering so Sentry sees every failure. Attribute
      // strictly from the explicit `chainBackend` URL param. Tag `unknown`
      // when missing rather than guessing (the missing-param path is
      // already a hard error from `main()`, but a thrown error before
      // that validation also lands here).
      const params = new URL(window.location.href).searchParams;
      const b = params.get(SANDBOX_CONTRACT_PARAMS.chainBackend);
      const dependency =
        b === "rpc-gateway"
          ? "ipfs-gateway"
          : b === "smoldot-direct" || b === "smoldot-shared-worker"
            ? "smoldot-bitswap"
            : "unknown";
      captureException(err, {
        surface: "sandbox_main",
        dependency,
        chain_backend: b ?? "unknown",
        attempt: String(runAttempts),
      });
      const message = err instanceof Error ? err.message : String(err);
      failLoading(
        "Failed to load content",
        `${message} (via ${dependency})`,
        () => {
          // Restore the loading UI and re-run main
          const app = document.getElementById("app") ?? document.body;
          app.innerHTML = `
        <div class="loading">
          <h1>dot.li</h1>
          <div class="spinner"></div>
          <p id="status">Retrying...</p>
        </div>
      `;
          run();
        },
      );
    })
    .finally(() => {
      runInFlight = false;
    });
}

run();
