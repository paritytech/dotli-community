// dot.li — Sandboxed content rendering
//
// Takes fetched content and renders it in a sandboxed <iframe>.
// The iframe isolates the resolved site from the viewer's origin.
//
// This module is bridge-free — it does not import the host bridge,
// auth, resolver, or smoldot. The host build uses bridge.ts which
// adds TrUAPI dApp ↔ host communication.

import { packArchive, type ArchiveFiles } from "@dotli/content/archive";
import { buildAllowAttribute } from "./permissions";

/**
 * Darken a CSS hex color by a given factor (0 = unchanged, 1 = black).
 * Falls back to the original value for non-hex colors.
 */
function darkenColor(color: string, amount: number): string {
  const match = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (!match) {
    return color;
  }
  let hex = match[1];
  // Expand shorthand (#abc → #aabbcc)
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const r = Math.round(parseInt(hex.slice(0, 2), 16) * (1 - amount));
  const g = Math.round(parseInt(hex.slice(2, 4), 16) * (1 - amount));
  const b = Math.round(parseInt(hex.slice(4, 6), 16) * (1 - amount));
  const toHex = (n: number): string =>
    Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const app = document.getElementById("app") ?? document.body;

let currentDispose: (() => void) | null = null;
let currentPanelDispose: (() => void) | null = null;
let currentBlobUrl: string | null = null;

/**
 * Capture deep link path (pathname + search + hash) to forward into the iframe.
 */
function getDeepPath(): string {
  const { pathname, search, hash } = window.location;
  // Strip the base path and .dot label segment from path-based URLs
  // e.g. /name.dot/foo/bar → /foo/bar, /dotli/name.dot/foo → /foo
  let p = pathname;
  const base = import.meta.env.BASE_URL;
  if (base !== "/" && p.startsWith(base)) {
    p = "/" + p.slice(base.length);
  }
  const stripped = p.replace(/^\/[^/]+\.dot/, "");
  const isRoot = stripped === "" || stripped === "/";
  // Even when the path is root, forward hash and search params to the iframe
  // so hash-based routing (e.g. /#/events/create) works correctly.
  if (isRoot) {
    return search || hash ? search + hash : "";
  }
  return stripped + search + hash;
}

/**
 * Render single-file HTML content in a sandboxed iframe.
 *
 * Creates a blob URL from the content and loads it in an iframe.
 */
export async function renderContent(
  content: Uint8Array,
  label: string,
): Promise<void> {
  cleanup();

  let html = new TextDecoder().decode(content);

  if (
    (import.meta.env.VITE_SANDBOX_CHECKER as string | undefined) !== undefined
  ) {
    const { injectSandboxChecker } =
      await import("@dotli/sandbox-checker/sandbox-checker");
    html = injectSandboxChecker(html);
  }

  // Create a blob URL so the iframe has a proper origin for postMessage
  const blob = new Blob([html], { type: "text/html" });
  let blobUrl = URL.createObjectURL(blob);
  currentBlobUrl = blobUrl;

  // Append hash fragment to blob URL so the dApp can read it
  const deepPath = getDeepPath();
  if (deepPath !== "") {
    const hashIndex = deepPath.indexOf("#");
    if (hashIndex !== -1) {
      blobUrl += deepPath.slice(hashIndex);
    }
  }

  renderIframe(blobUrl, label);
}

/**
 * Render a multi-file SPA archive via the Service Worker.
 *
 * Sends the file map to the SW, then loads the iframe from the SW scope.
 * The SW intercepts all fetch requests and serves files from the archive.
 */
export async function renderArchive(
  files: ArchiveFiles,
  label: string,
  cid?: string,
): Promise<void> {
  cleanup();

  const sw = navigator.serviceWorker.controller;
  if (sw === null) {
    // SW not ready — fall back to rendering index.html as single file
    const indexHtml = files["index.html"] as Uint8Array | undefined;
    if (indexHtml !== undefined) {
      await renderContent(indexHtml, label);
      return;
    }
    throw new Error("No service worker and no index.html in archive");
  }

  const { packed, index } = packArchive(files);

  // Wait for the SW to confirm it has received the archive
  const archiveReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener("message", handler);
      reject(
        new Error("Service worker did not acknowledge archive within 10s"),
      );
    }, 10_000);

    const handler = (evt: MessageEvent): void => {
      if ((evt.data as { type?: string } | null)?.type === "ARCHIVE_READY") {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener("message", handler);
        resolve();
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
  });

  // Send packed archive to the SW (single Transferable)
  sw.postMessage({ type: "SET_ARCHIVE", packed, index, domain: label, cid }, [
    packed,
  ]);

  // Wait for the SW to process the message (replaces 50ms setTimeout)
  await archiveReady;

  // Load the iframe from the SW scope, forwarding the deep link path
  const deepPath = getDeepPath();
  const appBase = `${import.meta.env.BASE_URL}dotli-app`;
  const swUrl =
    deepPath !== ""
      ? `${window.location.origin}${appBase}${deepPath}`
      : `${window.location.origin}${appBase}/index.html`;
  renderIframe(swUrl, label);
}

// Pre-created iframe element — call prepareIframe() early to avoid
// DOM creation overhead during the render-critical path.
let preparedIframe: HTMLIFrameElement | null = null;

/**
 * Pre-create the iframe element and append it (hidden) to the DOM.
 * Call this during the fetch/resolve phase so the iframe is ready instantly.
 */
export function prepareIframe(): void {
  if (preparedIframe) {
    return;
  }
  const hasTopbar = document.getElementById("topbar") !== null;
  const iframe = document.createElement("iframe");
  // TODO(security): allow-scripts + allow-same-origin together allows sandbox
  // escape. This is intentional — the host bridge (bridge.ts) needs
  // same-origin access to communicate with the parent frame via postMessage
  // and to access SW-served resources. Without allow-same-origin the SW cannot
  // intercept iframe fetches, breaking archive serving entirely.
  // TODO: sandbox permissions should be defined by a dApp manifest rather than
  // hardcoded — allow each product to declare its required permissions.
  iframe.sandbox.add(
    "allow-scripts",
    "allow-same-origin",
    "allow-forms",
    "allow-pointer-lock",
  );
  iframe.allow = "clipboard-write";
  iframe.style.cssText = hasTopbar
    ? "position:fixed;top:40px;left:0;width:100%;height:calc(100vh - 40px);border:none;margin:0;padding:0;visibility:hidden;"
    : "position:fixed;top:0;left:0;width:100%;height:100vh;border:none;margin:0;padding:0;visibility:hidden;";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  app.appendChild(iframe);
  preparedIframe = iframe;
}

export function renderIframe(url: string, label: string): void {
  const hasTopbar = document.getElementById("topbar") !== null;
  const iframeStyle = hasTopbar
    ? "position:fixed;top:40px;left:0;width:100%;height:calc(100vh - 40px);border:none;margin:0;padding:0;"
    : "position:fixed;top:0;left:0;width:100%;height:100vh;border:none;margin:0;padding:0;";

  const allowAttr = buildAllowAttribute(label);

  let iframe: HTMLIFrameElement;
  if (preparedIframe) {
    // Detach before clearing, then re-append
    iframe = preparedIframe;
    preparedIframe = null;
    iframe.remove();
    app.innerHTML = "";
    iframe.allow = allowAttr;
    iframe.style.cssText = iframeStyle;
    iframe.style.visibility = "visible";
    app.appendChild(iframe);
  } else {
    app.innerHTML = "";
    iframe = document.createElement("iframe");
    // TODO: sandbox permissions should be defined by a dApp manifest
    iframe.sandbox.add(
      "allow-scripts",
      "allow-same-origin",
      "allow-forms",
      "allow-pointer-lock",
    );
    iframe.allow = allowAttr;
    iframe.style.cssText = iframeStyle;
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    app.appendChild(iframe);
  }

  iframe.src = url;

  // Mirror the iframe's document.title and <meta name="theme-color"> to the
  // parent page. SPAs change these dynamically, so we observe mutations.
  const fallbackTitle = `${label}.dot`;
  iframe.addEventListener("load", () => {
    let doc: Document | null = null;
    try {
      doc = iframe.contentDocument;
      // eslint-disable-next-line no-restricted-syntax -- cross-origin iframe access: some browsers throw, others return null; both mean "can't read title from here" and the caller falls back to `${label}.dot`.
    } catch {
      /* cross-origin — fall through with doc=null */
    }

    if (!doc) {
      return;
    }

    const applyTitle = (): void => {
      document.title = doc.title || fallbackTitle;
    };
    applyTitle();
    const titleEl = doc.querySelector("title");
    if (titleEl) {
      new MutationObserver(applyTitle).observe(titleEl, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    mirrorThemeColor(doc);
  });
}

/**
 * Extract and apply theme-color from a same-origin document, with a
 * MutationObserver for SPA-injected meta tags.
 */
function mirrorThemeColor(doc: Document): void {
  const topbar = document.getElementById("topbar");
  const urlPill = document.getElementById("url-pill");
  if (!topbar) {
    return;
  }

  const applyThemeColor = (): void => {
    const color = resolveThemeColor(doc);
    if (color !== null) {
      applyTopbarColor(topbar, urlPill, color);
    }
  };
  applyThemeColor();
  new MutationObserver(applyThemeColor).observe(doc.head, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["content", "media"],
  });
  window.addEventListener("dotli:theme-changed", applyThemeColor);
}

/**
 * Resolve the best theme-color from a document, respecting
 * media="(prefers-color-scheme: light|dark)" variants.
 */
function resolveThemeColor(doc: Document): string | null {
  const scheme = document.documentElement.getAttribute("data-theme") ?? "dark";
  const specific = doc.querySelector<HTMLMetaElement>(
    `meta[name="theme-color"][media*="${scheme}"]`,
  );
  if (specific !== null && specific.content !== "") {
    return specific.content;
  }
  const metas = doc.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  for (const m of metas) {
    if (!m.hasAttribute("media") && m.content !== "") {
      return m.content;
    }
  }
  return null;
}

/** Apply a theme color to the topbar and URL pill. */
function applyTopbarColor(
  topbar: HTMLElement,
  urlPill: HTMLElement | null,
  color: string,
): void {
  topbar.style.backgroundColor = color;
  if (urlPill) {
    urlPill.style.backgroundColor = darkenColor(color, 0.35);
    urlPill.style.borderColor = darkenColor(color, 0.2);
  }
}

function cleanup(): void {
  if (currentPanelDispose) {
    currentPanelDispose();
    currentPanelDispose = null;
  }
  if (currentDispose) {
    currentDispose();
    currentDispose = null;
  }
  if (currentBlobUrl !== null) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  if (preparedIframe) {
    preparedIframe.remove();
    preparedIframe = null;
  }
}
