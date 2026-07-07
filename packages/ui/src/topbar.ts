// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Top bar UI
//
// Manages the auth button, QR pairing modal, and user popover.
// All plain DOM manipulation, no framework.
//
// Auth module is lazy-loaded. The heavy host-papp, statement-store, and
// polkadot-api WS deps only load when a persisted session exists or the
// user clicks the auth button.

import type { AuthState } from "@dotli/auth/auth";
import type { Identity } from "@novasamatech/host-papp";
import { log } from "@dotli/shared/log";
import { escapeHtml } from "@dotli/shared/html";
import { isMobileDevice } from "@dotli/shared/device";
import { toHex } from "@dotli/shared/hex";
import {
  formatAppVersion,
  getActiveAppManifest,
  getActiveRootManifest,
} from "@dotli/shared/active-manifest";
import { SITE_ID } from "@dotli/config/config";
import {
  createRemoteChainProvider,
  hasSharedAuthSession,
  isRemoteChainSupported,
} from "@dotli/protocol/client";
import {
  getCacheSettings,
  setCacheSettings,
  getBackend,
  setBackend,
  isSharedWorkerAvailable,
  isVerifiedSession,
  type Backend,
  type CacheSettings,
} from "@dotli/config/mode";
import { clearCidCache } from "@dotli/storage/cid-cache";
import {
  getEnabledNetworks,
  getNetwork,
  setNetwork,
  NETWORK_NAME_TO_SERVICES_CONFIG,
  type Network,
} from "@dotli/config/network";
import { getActiveServicesConfig } from "@dotli/config/network";
import { writeSettingsToSearch } from "@dotli/config/url-settings";
import {
  ALL_PERMISSIONS,
  getPermissionStatus,
  hasAnyGrant,
  isDevicePermission,
  resetPermission,
  setPermissionStatus,
  type PermissionStatus,
} from "./permissions";

function getElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`Element #${id} not found`);
  }
  return el;
}

// DOM refs are resolved lazily inside initTopBar() to avoid throwing
// at module scope if the HTML IDs change or the script loads early.
let authButton: HTMLElement;
let modalBackdrop: HTMLElement;
let modalTitle: HTMLElement;
let modalQr: HTMLElement;
let modalReason: HTMLElement;
let modalHint: HTMLElement;
let modalClose: HTMLElement;
let userPopover: HTMLElement;
let userPopoverUsername: HTMLElement;
let userPopoverDisconnect: HTMLElement;

let modeButton: HTMLElement;
let modePopover: HTMLElement;
let modePopoverContent: HTMLElement;
let modePopoverBackdrop: HTMLElement | null = null;

let permissionsButton: HTMLElement;
let permissionsPopover: HTMLElement;
let permissionsPopoverList: HTMLElement;
let permissionsPopoverBackdrop: HTMLElement | null = null;

/** The label of the currently loaded product (set via dotli:product-loaded event). */
let currentProductLabel: string | null = null;

/** True once the host has rendered an error page; no product will load. */
let productErrored = false;

// User icon for the logged-out state
const USER_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

// Track the current QR payload to prevent stale canvas appends
let currentQrPayload: string | null = null;

interface AuthModule {
  initAuth: () => Promise<void>;
  getAuthState: () => AuthState;
  onAuthStateChange: (fn: (state: AuthState) => void) => () => void;
  startPairing: () => void;
  abortPairing: () => void;
  disconnect: () => Promise<void>;
  shortenName: (identity: Identity) => string;
}

let authMod: AuthModule | null = null;

/**
 * Lazy-load and initialize the auth module. Subsequent calls return
 * the cached module immediately (initAuth is idempotent).
 */
async function ensureAuth(): Promise<AuthModule> {
  if (authMod) {
    return authMod;
  }
  authMod = await import("@dotli/auth/auth");
  await authMod.initAuth();
  authMod.onAuthStateChange(renderAuthState);
  renderAuthState(authMod.getAuthState());
  return authMod;
}

function getStoredTheme(): "light" | "dark" {
  const stored = localStorage.getItem("dotli-theme");
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  if (window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.setAttribute("data-theme", theme);
  // Notify the container bridge (container.ts) to forward the new theme to the
  // embedded dApp.
  window.dispatchEvent(new Event("dotli:theme-changed"));
}

function initThemeToggle(): void {
  applyTheme(getStoredTheme());

  const btn = document.getElementById("theme-toggle");
  if (btn === null) {
    return;
  }
  btn.addEventListener("click", () => {
    const next = getStoredTheme() === "dark" ? "light" : "dark";
    localStorage.setItem("dotli-theme", next);
    applyTheme(next);
  });
}

export function initTopBar(): void {
  authButton = getElement("auth-button");
  modalBackdrop = getElement("auth-modal-backdrop");
  modalTitle = getElement("auth-modal-title");
  modalQr = getElement("auth-modal-qr");
  modalReason = getElement("auth-modal-reason");
  modalHint = getElement("auth-modal-hint");
  modalClose = getElement("auth-modal-close");
  userPopover = getElement("user-popover");
  userPopoverUsername = getElement("user-popover-username");
  userPopoverDisconnect = getElement("user-popover-disconnect");

  // Auth button: opens modal (logged out) or popover (logged in)
  authButton.addEventListener("click", handleAuthButtonClick);
  authButton.removeAttribute("disabled");

  // Modal close button
  modalClose.addEventListener("click", closeModal);

  // Clicking backdrop (outside modal) closes modal
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      closeModal();
    }
  });

  // Disconnect button
  userPopoverDisconnect.addEventListener("click", handleDisconnect);

  // Products can trigger the login flow via `handleRequestLogin`.
  // `requestLogin()` in @dotli/auth dispatches this event after checking
  // the already-connected fast path. The topbar owns the QR modal so we
  // open it here and kick off pairing.
  window.addEventListener("dotli:request-login", (e: Event) => {
    const detail = (e as CustomEvent<{ reason?: string; label?: string }>)
      .detail;
    openModal(detail.reason, detail.label);
    void ensureAuth().then(() => {
      // Skip if the flow advanced between dispatch and here.
      const state = authMod?.getAuthState();
      if (
        state &&
        state.status !== "authenticated" &&
        state.status !== "pairing" &&
        state.status !== "attesting"
      ) {
        authMod?.startPairing();
      }
    });
  });

  // Mobile-only "more" menu: collapses Permissions / Theme / Settings into a
  // single flyout. Each row delegates to .click() on the real button so the
  // existing handlers (and their viewport-anchored popovers) work unchanged.
  const moreButton = document.getElementById("more-button");
  const morePopover = document.getElementById("more-popover");
  if (moreButton !== null && morePopover !== null) {
    const setMoreOpen = (open: boolean): void => {
      morePopover.classList.toggle("open", open);
      moreButton.setAttribute("aria-expanded", String(open));
    };
    moreButton.addEventListener("click", () => {
      // Don't stop propagation: let the document-level close-outside handler
      // run so opening the burger also closes settings/permissions popovers.
      // That handler won't touch the more popover itself because
      // `moreButton.contains(target)` is true for clicks on the burger.
      setMoreOpen(!morePopover.classList.contains("open"));
    });
    morePopover.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLButtonElement>(
        ".more-row",
      );
      if (row === null) {
        return;
      }
      // Prevent the original .more-row click from bubbling to the
      // document-level close-outside handler below: that handler would see
      // the row click as "outside" the just-opened target popover and
      // immediately close it back.
      e.stopPropagation();
      setMoreOpen(false);
      const targetId = row.dataset.target;
      if (targetId !== undefined) {
        document.getElementById(targetId)?.click();
      }
    });
  }

  // Close popovers when clicking outside
  document.addEventListener("click", (e) => {
    if (
      morePopover !== null &&
      moreButton !== null &&
      morePopover.classList.contains("open") &&
      !morePopover.contains(e.target as Node) &&
      !moreButton.contains(e.target as Node)
    ) {
      morePopover.classList.remove("open");
      moreButton.setAttribute("aria-expanded", "false");
    }
    if (
      userPopover.classList.contains("open") &&
      !userPopover.contains(e.target as Node) &&
      !authButton.contains(e.target as Node)
    ) {
      userPopover.classList.remove("open");
    }
    if (
      modePopover.classList.contains("open") &&
      !modePopover.contains(e.target as Node) &&
      !modeButton.contains(e.target as Node)
    ) {
      setModePopoverOpen(false);
    }
    if (
      permissionsPopover.classList.contains("open") &&
      !permissionsPopover.contains(e.target as Node) &&
      !permissionsButton.contains(e.target as Node)
    ) {
      setPermissionsPopoverOpen(false);
    }
  });

  // Set logo home link from VITE_APP_URL (defaults to /)
  const homeLink = document.getElementById(
    "topbar-home",
  ) as HTMLAnchorElement | null;
  if (homeLink !== null) {
    homeLink.href = (import.meta.env.VITE_APP_URL as string | undefined) ?? "/";
  }

  // Theme toggle
  initThemeToggle();

  // Mode toggle (P2P / Centralized)
  initModeToggle();

  // Permissions
  initPermissions();

  // Show default logged-out state
  renderLoggedOut();

  // Probe the shared auth storage on host.dot.li. Sessions now live on the
  // shared host origin so sibling host shells can rehydrate after a
  // cross-subdomain navigation without eagerly loading the auth bundle for
  // every visitor.
  requestIdleCallback(() => {
    void (async () => {
      try {
        if (await hasSharedAuthSession(SITE_ID)) {
          await ensureAuth();
        }
      } catch (error) {
        log.warn("[dot.li auth] Shared session probe failed:", error);
      }
    })();
  });
}

function renderAuthState(state: AuthState): void {
  switch (state.status) {
    case "idle":
      renderLoggedOut();
      break;
    case "pairing":
      renderPairing(state.payload);
      break;
    case "attesting":
      renderAttesting();
      break;
    case "authenticated":
      renderLoggedIn(state);
      closeModal();
      break;
    case "error":
      renderError(state.message);
      break;
  }
}

function renderLoggedOut(): void {
  authButton.innerHTML = USER_SVG;
  authButton.title = "Login with Polkadot Mobile";
  window.dispatchEvent(new Event("dotli:logged-out"));
}

function renderLoggedIn(state: AuthState & { status: "authenticated" }): void {
  const initials =
    state.identity && authMod ? authMod.shortenName(state.identity) : "??";
  authButton.innerHTML = `<div class="user-badge">${escapeHtml(initials)}</div>`;
  authButton.title = "Account";
  window.dispatchEvent(new Event("dotli:authenticated"));

  // Update popover with identity name or truncated account address
  let username: string;
  const fullName = state.identity?.fullUsername;
  const liteName = state.identity?.liteUsername;
  if (
    (fullName !== undefined && fullName !== "") ||
    (liteName !== undefined && liteName !== "")
  ) {
    username = fullName ?? liteName ?? "";
  } else {
    // Fallback to truncated account address
    const id = toHex(state.session.remoteAccount.accountId).slice(2);
    username = `0x${id.slice(0, 6)}...${id.slice(-4)}`;
  }
  userPopoverUsername.textContent = username;
}

function renderPairing(payload: string): void {
  currentQrPayload = payload;

  if (!payload) {
    // Initial state, show spinner
    modalQr.innerHTML = `<div class="spinner"></div>`;
    return;
  }

  // Render QR code (lazy-load qrcode lib, guard against stale appends)
  const canvas = document.createElement("canvas");
  canvas.dataset.qrPayload = payload;
  const capturedPayload = payload;
  void import("qrcode")
    .then((QRCode) =>
      QRCode.default.toCanvas(canvas, payload, {
        width: 200,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      }),
    )
    .then(() => {
      // Only append if this payload is still current
      if (currentQrPayload !== capturedPayload) {
        return;
      }
      modalQr.innerHTML = "";

      if (isMobileDevice()) {
        // No second device to scan with, so the deeplink button leads and the
        // QR is opt-in behind "Show QR instead" for pairing from another device.
        modalQr.classList.add("auth-modal-qr-mobile");

        const qrLink = document.createElement("a");
        qrLink.href = payload;
        qrLink.className = "auth-modal-qr-link";
        qrLink.appendChild(canvas);
        qrLink.hidden = true;

        const openApp = document.createElement("a");
        openApp.href = payload;
        openApp.className = "auth-modal-open-app";
        openApp.textContent = "Login With Polkadot App";

        const showQr = document.createElement("button");
        showQr.type = "button";
        showQr.className = "auth-modal-qr-toggle";
        showQr.textContent = "Show QR instead";
        showQr.addEventListener("click", () => {
          qrLink.hidden = false;
          openApp.classList.add("auth-modal-open-app-link");
          showQr.hidden = true;
          // Re-append to put the QR on top and the demoted deeplink below it.
          modalQr.append(qrLink, openApp);
          modalHint.textContent = "Scan with Polkadot Mobile to connect";
        });

        modalQr.append(openApp, showQr, qrLink);
      } else {
        modalQr.classList.remove("auth-modal-qr-mobile");
        modalQr.appendChild(canvas);
      }
    })
    .catch((err: unknown) => {
      log.error("[dot.li] QR render failed:", err);
    });
}

function renderAttesting(): void {
  modalQr.innerHTML = `
    <div class="attesting">
      <div class="spinner"></div>
      <p>Logging in...</p>
    </div>
  `;
}

// Clock glyph for the "account still being set up" state.
const PENDING_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

// Recognize known wallet-side SSO failures and return friendly copy, or null to
// fall back to the raw error. OriginPersonProviderError ("error 0" =
// noPersonsExist) means the signer's personhood is not yet included in a VRF
// ring, so the wallet cannot grant the host its statement-store allowance yet.
function friendlyAuthError(
  message: string,
): { title: string; subtitle: string } | null {
  if (message.includes("OriginPersonProviderError")) {
    return {
      title: "Your account is still being set up",
      subtitle: "Please try again later",
    };
  }
  return null;
}

function renderError(message: string): void {
  const container = document.createElement("div");
  container.className = "auth-modal-error-view";

  const friendly = friendlyAuthError(message);
  if (friendly) {
    const icon = document.createElement("div");
    icon.className = "auth-modal-pending-icon";
    icon.innerHTML = PENDING_ICON_SVG;
    container.appendChild(icon);

    const title = document.createElement("div");
    title.className = "auth-modal-pending-title";
    title.textContent = friendly.title;
    container.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "auth-modal-pending-subtitle";
    subtitle.textContent = friendly.subtitle;
    container.appendChild(subtitle);
  } else {
    const msg = document.createElement("p");
    msg.className = "auth-modal-error";
    msg.textContent = message;
    container.appendChild(msg);
  }

  const retry = document.createElement("button");
  retry.className = "auth-modal-retry";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => {
    authMod?.startPairing();
  });
  container.appendChild(retry);

  modalQr.innerHTML = "";
  modalQr.appendChild(container);
}

function handleAuthButtonClick(): void {
  if (authMod) {
    const state = authMod.getAuthState();

    if (state.status === "authenticated") {
      // Toggle user popover
      userPopover.classList.toggle("open");
    } else if (state.status === "attesting") {
      // Attestation still running in background, just reshow the modal
      modalBackdrop.classList.add("open");
    } else {
      // Open modal and start pairing
      openModal();
      authMod.startPairing();
    }
  } else {
    // Auth not loaded yet, load it and start pairing
    openModal();
    void ensureAuth().then(() => {
      authMod?.startPairing();
    });
  }
}

function handleDisconnect(): void {
  userPopover.classList.remove("open");
  if (authMod) {
    void authMod.disconnect();
  }
}

const PERM_ICONS: Record<string, string> = {
  Camera:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  Microphone:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  Location:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  Bluetooth:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>',
  Notifications:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  NFC: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 7a7 7 0 0 1 0 10"/><path d="M13 9a4 4 0 0 1 0 6"/><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/></svg>',
  Clipboard:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
  OpenUrl:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  Biometrics:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11a4 4 0 0 0-4 4v2a4 4 0 0 0 8 0v-2a4 4 0 0 0-4-4z"/><path d="M6 11a6 6 0 0 1 12 0"/><path d="M4 11a8 8 0 0 1 16 0"/></svg>',
  ChainSubmit:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  PreimageSubmit:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  StatementSubmit:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>',
  GetUserId:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
};

function initPermissions(): void {
  permissionsButton = getElement("permissions-button");
  permissionsPopover = getElement("permissions-popover");
  permissionsPopoverList = getElement("permissions-popover-list");
  // Backdrop is optional. Older host shells that haven't added the element
  // still work, the popover just doesn't get a modal overlay there.
  permissionsPopoverBackdrop = document.getElementById(
    "permissions-popover-backdrop",
  );

  permissionsButton.addEventListener("click", () => {
    const willOpen = !permissionsPopover.classList.contains("open");
    setPermissionsPopoverOpen(willOpen);
  });

  // Clicking the backdrop dismisses the popover (same as clicking outside).
  permissionsPopoverBackdrop?.addEventListener("click", () => {
    setPermissionsPopoverOpen(false);
  });

  // Update when a product is loaded
  window.addEventListener("dotli:product-loaded", (e) => {
    const { label } = (e as CustomEvent<{ label: string }>).detail;
    currentProductLabel = label;
    productErrored = false;
    updatePermissionsButtonState();
    if (permissionsPopover.classList.contains("open")) {
      renderPermissionsPopover();
    }
  });

  // Re-render the popover hint when the host swaps in an error page.
  // Clear the label too so any previously loaded product's grants stop
  // showing. The error page means no product is mounted.
  window.addEventListener("dotli:product-error", () => {
    productErrored = true;
    currentProductLabel = null;
    updatePermissionsButtonState();
    if (permissionsPopover.classList.contains("open")) {
      renderPermissionsPopover();
    }
  });

  // Update after permission changes
  window.addEventListener("dotli:device-permission-changed", () => {
    updatePermissionsButtonState();
    if (permissionsPopover.classList.contains("open")) {
      renderPermissionsPopover();
    }
  });

  window.addEventListener("dotli:permission-changed", () => {
    updatePermissionsButtonState();
    if (permissionsPopover.classList.contains("open")) {
      renderPermissionsPopover();
    }
  });
}

/** Update the shield icon to reflect whether any permissions are active. */
function updatePermissionsButtonState(): void {
  if (currentProductLabel === null) {
    permissionsButton.classList.remove("has-grants");
    return;
  }
  permissionsButton.classList.toggle(
    "has-grants",
    hasAnyGrant(currentProductLabel),
  );
}

const STATUS_LABELS: Record<PermissionStatus, string> = {
  ask: "Ask (Default)",
  granted: "Allowed",
  denied: "Denied",
};

const STATUS_ORDER: readonly PermissionStatus[] = ["ask", "granted", "denied"];

let openDropdownCleanup: (() => void) | null = null;

function closeOpenDropdown(): void {
  openDropdownCleanup?.();
  openDropdownCleanup = null;
}

function renderPermissionsPopover(): void {
  closeOpenDropdown();
  permissionsPopoverList.innerHTML = "";

  if (currentProductLabel === null) {
    const hint = document.createElement("div");
    hint.className = "permissions-popover-footer";
    hint.textContent = productErrored
      ? "No app is loaded on this domain."
      : "Wait for the app to finish loading to change its permissions.";
    permissionsPopoverList.appendChild(hint);
    return;
  }

  for (const perm of ALL_PERMISSIONS) {
    const productLabel = currentProductLabel;
    const status = getPermissionStatus(productLabel, perm.name);

    const row = document.createElement("div");
    row.className = "permissions-popover-row";

    const icon = document.createElement("span");
    icon.className = "permissions-popover-icon";
    icon.innerHTML = PERM_ICONS[perm.name] ?? "";
    row.appendChild(icon);

    const nameEl = document.createElement("span");
    nameEl.className = "permissions-popover-name";
    nameEl.textContent = perm.label;
    row.appendChild(nameEl);

    row.appendChild(
      createPermissionDropdown(status, (next) => {
        if (next === "ask") {
          resetPermission(productLabel, perm.name);
        } else {
          setPermissionStatus(productLabel, perm.name, next);
        }
        // Device permissions need iframe reload (allow attribute changes).
        // Non-device permissions just update the UI.
        const event = isDevicePermission(perm.name)
          ? "dotli:device-permission-changed"
          : "dotli:permission-changed";
        window.dispatchEvent(
          new CustomEvent(event, {
            detail: { label: productLabel, permission: perm.name },
          }),
        );
        renderPermissionsPopover();
      }),
    );

    permissionsPopoverList.appendChild(row);
  }

  // Footer notice
  const footer = document.createElement("div");
  footer.className = "permissions-popover-footer";
  footer.textContent = "Changing permissions will reload the app.";
  permissionsPopoverList.appendChild(footer);
}

function createPermissionDropdown(
  currentStatus: PermissionStatus,
  onChange: (status: PermissionStatus) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "permissions-popover-select-wrap";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "permissions-popover-select";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const triggerLabel = document.createElement("span");
  triggerLabel.className = "permissions-popover-select-label";
  triggerLabel.textContent = STATUS_LABELS[currentStatus];
  trigger.appendChild(triggerLabel);

  const caret = document.createElement("span");
  caret.className = "permissions-popover-select-caret";
  caret.innerHTML =
    '<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">' +
    '<path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  trigger.appendChild(caret);

  wrap.appendChild(trigger);

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    // Clicking the trigger while this row's menu is open should close it.
    if (wrap.querySelector(".permissions-popover-menu") !== null) {
      closeOpenDropdown();
      return;
    }
    closeOpenDropdown();

    const menu = document.createElement("div");
    menu.className = "permissions-popover-menu";
    menu.setAttribute("role", "listbox");

    for (const status of STATUS_ORDER) {
      const item = document.createElement("button");
      item.type = "button";
      const selected = status === currentStatus;
      item.className = `permissions-popover-menu-item${selected ? " selected" : ""}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(selected));

      const text = document.createElement("span");
      text.textContent = STATUS_LABELS[status];
      item.appendChild(text);

      if (selected) {
        const check = document.createElement("span");
        check.className = "permissions-popover-menu-check";
        check.innerHTML =
          '<svg viewBox="0 0 12 10" width="12" height="10" aria-hidden="true">' +
          '<path d="M1 5l3.5 3.5L11 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        item.appendChild(check);
      }

      item.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeOpenDropdown();
        onChange(status);
      });

      menu.appendChild(item);
    }

    wrap.appendChild(menu);
    trigger.setAttribute("aria-expanded", "true");

    function onDocClick(ev: MouseEvent): void {
      if (!wrap.contains(ev.target as Node)) {
        closeOpenDropdown();
      }
    }
    function onKeyDown(ev: KeyboardEvent): void {
      if (ev.key === "Escape") {
        closeOpenDropdown();
      }
    }
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);

    openDropdownCleanup = (): void => {
      menu.remove();
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  });

  return wrap;
}

function initModeToggle(): void {
  modeButton = getElement("mode-button");
  modePopover = getElement("mode-popover");
  modePopoverContent = getElement("mode-popover-content");
  // Backdrop is optional. Older host shells that haven't added the element
  // still work, the popover just doesn't get a modal overlay there.
  modePopoverBackdrop = document.getElementById("mode-popover-backdrop");

  // Show the "trusted provider" indicator on the settings button whenever
  // the session is not fully verified, i.e. chain=rpc or content=gateway
  // on either axis. The rule is owned by `isVerifiedSession` so this
  // button and the host shield can never disagree on trust posture.
  modeButton.classList.toggle("gateway-mode", !isVerifiedSession(getBackend()));

  modeButton.addEventListener("click", () => {
    if (modePopover.classList.contains("open")) {
      setModePopoverOpen(false);
    } else {
      setModePopoverOpen(true);
    }
  });

  // Clicking the backdrop dismisses the popover (same as clicking outside).
  modePopoverBackdrop?.addEventListener("click", () => {
    setModePopoverOpen(false);
  });
}

/**
 * Single source of truth for popover open/close. Keeps the backdrop in
 * sync with the popover visibility so "the rest of the page is blocked
 * while settings are open" always holds.
 */
function setModePopoverOpen(open: boolean): void {
  modePopover.classList.toggle("open", open);
  modePopoverBackdrop?.classList.toggle("open", open);
  if (open) {
    renderModePopover();
  }
}

/**
 * Single source of truth for the permissions popover. Keeps the backdrop
 * in sync so "the rest of the page is blocked while permissions are open"
 * holds the same way it does for settings.
 */
function setPermissionsPopoverOpen(open: boolean): void {
  permissionsPopover.classList.toggle("open", open);
  permissionsPopoverBackdrop?.classList.toggle("open", open);
  if (open) {
    renderPermissionsPopover();
  } else {
    closeOpenDropdown();
  }
}

/**
 * Draft of everything the popover can change. Controls mutate this. Nothing
 * touches localStorage or reloads the page until the user clicks Save &
 * Apply. Closing the popover throws the draft away. The next open re-reads
 * persisted state from scratch, so partial changes never leak.
 */
interface ModeDraft {
  chain: Backend;
  network: Network;
  cache: CacheSettings;
}

function renderModePopover(): void {
  // Two-column grid. Left: backend / cache. Right: endpoints / diagnostics.
  // Save & Apply and the footer spans both columns at the bottom. Collapses
  // to a single column on narrow viewports (CSS media query on
  // `.mode-popover-columns`).
  const parent = modePopoverContent;
  parent.innerHTML = "";

  // Mobile-only sheet header. On phones the popover becomes a full-screen
  // sheet (CSS), which has no tappable backdrop to dismiss it, so it needs an
  // explicit title and close control. Hidden on desktop, where the backdrop
  // still handles dismissal.
  const sheetHeader = document.createElement("div");
  sheetHeader.className = "mode-popover-sheet-header";
  const sheetTitle = document.createElement("span");
  sheetTitle.className = "mode-popover-sheet-title";
  sheetTitle.textContent = "Settings";
  const sheetClose = document.createElement("button");
  sheetClose.className = "mode-popover-sheet-close";
  sheetClose.setAttribute("aria-label", "Close settings");
  sheetClose.textContent = "✕";
  sheetClose.addEventListener("click", () => {
    setModePopoverOpen(false);
  });
  sheetHeader.append(sheetTitle, sheetClose);
  parent.appendChild(sheetHeader);

  const persisted: ModeDraft = {
    chain: getBackend(),
    network: getNetwork(),
    cache: getCacheSettings(),
  };
  const draft: ModeDraft = { ...persisted, cache: { ...persisted.cache } };

  // Forward declarations so controls can re-sync the apply button whenever
  // they mutate the draft.
  let syncApply: () => void = () => {
    /* filled in below */
  };

  const columns = document.createElement("div");
  columns.className = "mode-popover-columns";
  parent.appendChild(columns);

  const leftCol = document.createElement("div");
  leftCol.className = "mode-popover-col";
  columns.appendChild(leftCol);

  const rightCol = document.createElement("div");
  rightCol.className = "mode-popover-col";
  columns.appendChild(rightCol);

  const enabledNetworks = getEnabledNetworks();
  if (enabledNetworks.length > 1) {
    appendSectionHeader(leftCol, "Network");
    const networkChoices: [Network, string, string][] = enabledNetworks.map(
      (n) => {
        const cfg = NETWORK_NAME_TO_SERVICES_CONFIG[n];
        return [n, cfg.label, cfg.description];
      },
    );
    const networkGroup = document.createElement("div");
    leftCol.appendChild(networkGroup);
    const rerenderNetwork = (): void => {
      networkGroup.innerHTML = "";
      for (const [value, label, desc] of networkChoices) {
        renderNetworkRadio(
          networkGroup,
          value,
          label,
          desc,
          draft.network,
          (next) => {
            draft.network = next;
            rerenderNetwork();
            syncApply();
          },
        );
      }
    };
    rerenderNetwork();
    appendDivider(leftCol);
  }

  appendSectionHeader(leftCol, "Backend");
  const chainChoices: [Backend, string, string][] = [
    [
      "smoldot-shared-worker",
      "Light Client Shared",
      "Verified in your browser, shared across tabs (recommended)",
    ],
    [
      "smoldot-direct",
      "Light Client Per-Tab",
      "Verified in your browser, separate per tab",
    ],
    [
      "rpc-gateway",
      "Trusted Providers",
      "Fetched from trusted servers, fastest but less private",
    ],
  ];
  const chainGroup = document.createElement("div");
  leftCol.appendChild(chainGroup);
  const sharedWorkerSupported = isSharedWorkerAvailable();
  const rerenderChain = (): void => {
    chainGroup.innerHTML = "";
    for (const [value, label, desc] of chainChoices) {
      const disabled =
        value === "smoldot-shared-worker" && !sharedWorkerSupported;
      const effectiveDesc = disabled
        ? "Unavailable in this browser or private window"
        : desc;
      renderChainRadio(
        chainGroup,
        value,
        label,
        effectiveDesc,
        draft.chain,
        disabled,
        (next) => {
          draft.chain = next;
          rerenderChain();
          syncApply();
        },
      );
    }
  };
  rerenderChain();

  appendDivider(leftCol);
  appendSectionHeader(leftCol, "Cache");
  renderCacheToggle(
    leftCol,
    "dotNS cache",
    !draft.cache.skipCidCache,
    (enabled) => {
      draft.cache = { ...draft.cache, skipCidCache: !enabled };
      syncApply();
    },
  );
  renderCacheToggle(
    leftCol,
    "Archive cache",
    !draft.cache.skipArchiveCache,
    (enabled) => {
      draft.cache = { ...draft.cache, skipArchiveCache: !enabled };
      syncApply();
    },
  );
  // Worker cache: when off, the protocol iframe purges its IDB state
  // (smoldot chain DB and polkadot-api caches) before initialisation, so
  // every cold start boots from scratch. Trades startup time for a
  // deterministic baseline.
  renderCacheToggle(
    leftCol,
    "Worker cache",
    !draft.cache.skipWorkerCache,
    (enabled) => {
      draft.cache = { ...draft.cache, skipWorkerCache: !enabled };
      syncApply();
    },
  );

  // Manual "clear everything" escape hatch. Reuses the same full-reset
  // pipeline as Save & Apply so users don't have to toggle a setting back
  // and forth just to wipe state. Kept here (bottom of the Cache section)
  // because conceptually it's the same capability as the cache toggles,
  // just "all of them, now, regardless of the current choice".
  const clearRow = document.createElement("div");
  clearRow.className = "mode-cache-row mode-clear-all-row";
  const clearBtn = document.createElement("button");
  clearBtn.className = "mode-clear-btn";
  clearBtn.textContent = "Clear all caches";
  clearBtn.title =
    "Wipe every cache, database, and worker across all origins. The app will reload from a clean baseline.";
  clearBtn.addEventListener("click", () => {
    if (clearBtn.disabled) {
      return;
    }
    clearBtn.disabled = true;
    clearBtn.textContent = "Clearing…";
    // Force the full-reset pipeline: wipe every origin regardless of the
    // current cache toggles, then re-seed localStorage with the baseline.
    void applyAndReset(persisted, persisted, { forceFullWipe: true });
  });
  clearRow.appendChild(clearBtn);
  leftCol.appendChild(clearRow);

  appendSectionHeader(rightCol, "Diagnostics");
  renderDiagnostics(rightCol);

  // Footer wraps the divider, Save & Apply, and the warning as one unit so it
  // can pin to the bottom of the full-screen sheet on mobile (CSS), keeping
  // the primary action reachable. On desktop it is plain in-flow content.
  const footer = document.createElement("div");
  footer.className = "mode-apply-footer";
  parent.appendChild(footer);

  appendDivider(footer);
  const applyRow = document.createElement("div");
  applyRow.className = "mode-cache-row mode-apply-row";
  const applyBtn = document.createElement("button");
  applyBtn.className = "mode-clear-btn";
  applyRow.appendChild(applyBtn);
  footer.appendChild(applyRow);

  // Warning text: applying reloads the app. Backend/network changes keep
  // caches warm; only caches the user turns off get cleared. Shown only
  // when the draft is dirty so the idle popover isn't noisy.
  const resetWarning = document.createElement("p");
  resetWarning.className = "mode-apply-warning";
  resetWarning.textContent =
    "Applying reloads the app. Caches you turn off are cleared.";
  footer.appendChild(resetWarning);

  syncApply = (): void => {
    const dirty =
      draft.chain !== persisted.chain ||
      draft.network !== persisted.network ||
      draft.cache.skipCidCache !== persisted.cache.skipCidCache ||
      draft.cache.skipArchiveCache !== persisted.cache.skipArchiveCache ||
      draft.cache.skipWorkerCache !== persisted.cache.skipWorkerCache;
    applyBtn.disabled = !dirty;
    applyBtn.textContent = "Save & Apply";
    applyBtn.classList.toggle("mode-apply-dirty", dirty);
    resetWarning.classList.toggle("visible", dirty);
  };
  syncApply();

  applyBtn.addEventListener("click", () => {
    if (applyBtn.disabled) {
      return;
    }
    applyBtn.disabled = true;
    applyBtn.textContent = "Resetting…";
    void applyAndReset(draft, persisted);
  });
}

/**
 * Apply the pending draft, then reload. Cache deletion is scoped to what
 * actually changed:
 *
 *   - Backend or network changes delete nothing. The cached CID, archive,
 *     and worker state stay warm.
 *   - Turning a cache toggle off clears that cache's origin:
 *       dotNS clears the host-origin CID store here, directly.
 *       Archive flags the sandbox iframe to purge its origin on next boot
 *               (reuses the existing `pending-reset:sandbox` signal the
 *               bridge already consumes).
 *       Worker needs no signal. The persisted `skipWorkerCache` flag
 *              makes the protocol iframe purge on its next boot.
 *
 * `forceFullWipe` (the "Clear all caches" button) bypasses the diff and
 * wipes every origin via the original full-reset pipeline: wipe host state,
 * re-apply settings, and flag the protocol and sandbox iframes to purge
 * themselves regardless of their persisted prefs.
 *
 * Order matters: persist settings first (so the reload boots with them),
 * run the host-origin deletes, mark cross-origin one-shot signals, reload.
 */
async function applyAndReset(
  draft: ModeDraft,
  prior: ModeDraft,
  { forceFullWipe = false }: { forceFullWipe?: boolean } = {},
): Promise<void> {
  try {
    if (forceFullWipe) {
      // Snapshot the theme so the wipe (which clears localStorage) doesn't
      // yank the user into a different colour scheme.
      const theme = localStorage.getItem("dotli-theme");
      await wipeOriginState();
      setBackend(draft.chain);
      setNetwork(draft.network);
      setCacheSettings(draft.cache);
      if (theme === "light" || theme === "dark") {
        localStorage.setItem("dotli-theme", theme);
      }
      // Force every origin to purge regardless of persisted prefs.
      try {
        sessionStorage.setItem("dotli:pending-reset:protocol", "1");
        sessionStorage.setItem("dotli:pending-reset:sandbox", "1");
        // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable (Safari private mode); cross-origin purges are best-effort, reload below is unconditional.
      } catch {
        /* sessionStorage unavailable: cross-origin purges skipped */
      }
    } else {
      // No origin wipe. Persist the new choices, then delete only the caches
      // the user just turned off (skip flag flipped from false to true).
      setBackend(draft.chain);
      setNetwork(draft.network);
      setCacheSettings(draft.cache);

      const cidTurnedOff =
        draft.cache.skipCidCache && !prior.cache.skipCidCache;
      const archiveTurnedOff =
        draft.cache.skipArchiveCache && !prior.cache.skipArchiveCache;

      if (cidTurnedOff) {
        await clearCidCache();
      }
      if (archiveTurnedOff) {
        // Archive cache lives on the sandbox origin, unreachable from here.
        // Reuse the existing one-shot flag the bridge turns into fullReset=1
        // so the sandbox purges itself on its next boot.
        try {
          sessionStorage.setItem("dotli:pending-reset:sandbox", "1");
          // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable (Safari private mode); the sandbox purge is best-effort, reload below is unconditional.
        } catch {
          /* sessionStorage unavailable: sandbox purge skipped */
        }
      }
    }

    // Mirror the new settings to the URL so the reload below boots with
    // the same effective state the user just picked. Defaults drop off
    // so a clean dot.li URL keeps meaning "every axis at default".
    const search = new URLSearchParams(window.location.search);
    if (
      writeSettingsToSearch(
        {
          network: draft.network,
          chainBackend: draft.chain,
          cache: draft.cache,
        },
        search,
      )
    ) {
      const query = search.toString();
      const newUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", newUrl);
    }
  } finally {
    window.location.reload();
  }
}

/**
 * Wipe this origin's IDB, CacheStorage, SW registrations, localStorage,
 * sessionStorage. Best-effort: Firefox and Safari pre-17 lack
 * `indexedDB.databases()`. Callers must snapshot keys they need preserved
 * (theme, settings) and re-write them after, since localStorage is cleared.
 */
export async function wipeOriginState(): Promise<void> {
  await Promise.allSettled([deleteAllIndexedDBs(), deleteAllCacheStorage()]);
  await unregisterAllServiceWorkers();
  try {
    sessionStorage.clear();
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage unavailable (Safari private mode). Full reset is best-effort; anything we can't clear just means a partial baseline.
  } catch {
    /* sessionStorage unavailable */
  }
  try {
    localStorage.clear();
    // eslint-disable-next-line no-restricted-syntax -- localStorage unavailable. Full reset is best-effort.
  } catch {
    /* localStorage unavailable */
  }
}

async function deleteAllIndexedDBs(): Promise<void> {
  try {
    if (
      typeof indexedDB === "undefined" ||
      typeof indexedDB.databases !== "function"
    ) {
      return;
    }
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
            // Cap each delete at 3s in case Chromium never fires success/error/blocked.
            const timer = setTimeout(resolve, 3000);
            const settle = (): void => {
              clearTimeout(timer);
              resolve();
            };
            req.onsuccess = settle;
            req.onerror = settle;
            req.onblocked = settle;
          }),
      ),
    );
    // eslint-disable-next-line no-restricted-syntax -- full-reset is best-effort; any surviving IDB just means partial baseline. Next boot will still see the new mode settings.
  } catch {
    /* best-effort IDB wipe */
  }
}

async function deleteAllCacheStorage(): Promise<void> {
  try {
    if (typeof caches === "undefined") {
      return;
    }
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    // eslint-disable-next-line no-restricted-syntax -- full-reset is best-effort; partial CacheStorage survival is acceptable.
  } catch {
    /* best-effort CacheStorage wipe */
  }
}

async function unregisterAllServiceWorkers(): Promise<void> {
  try {
    if (!("serviceWorker" in navigator)) {
      return;
    }
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    // eslint-disable-next-line no-restricted-syntax -- full-reset is best-effort; surviving SW registration will be replaced on next install.
  } catch {
    /* best-effort SW unregister */
  }
}

function appendSectionHeader(parent: HTMLElement, text: string): void {
  const header = document.createElement("div");
  header.className = "mode-popover-section";
  header.textContent = text;
  parent.appendChild(header);
}

// Baked at build time by `apps/host/vite.config.ts` (`define.*`). The
// topbar only ever renders in the host shell so these will always be
// present in practice. `undefined` fallbacks are defensive for tests and
// for any future caller that imports this module from a different bundle.
declare const __DOTLI_VERSION__: string | undefined;
declare const __SMOLDOT_VERSION__: string | undefined;
declare const __SMOLDOT_COMMIT__: string | undefined;
declare const __POLKADOT_API_VERSION__: string | undefined;
declare const __POLKADOT_API_VERSIONS__:
  | { name: string; version: string }[]
  | undefined;
declare const __NOVASAMATECH_VERSIONS__:
  | { name: string; version: string }[]
  | undefined;

/**
 * Render the Diagnostics block at the bottom of the settings popover. Rows
 * are static (no click-to-copy). The "Share diagnostic" button at the end
 * exports the whole block at once, so individual-row copy would be noise.
 *
 * Values come from places that are cheap to read synchronously so the
 * popover doesn't pop open with a spinner. "unknown" is a valid value, so
 * don't over-engineer fallbacks.
 */
function renderDiagnostics(parent: HTMLElement): void {
  const base = buildBaseDiagnosticsRows();
  const rowHandles = new Map<string, InfoRowHandle>();
  const COPYABLE_ROWS = new Set([
    "Site",
    "Relay node",
    "AssetHub node",
    "Bulletin Node",
  ]);
  for (const entry of base) {
    rowHandles.set(
      entry[0],
      renderInfoRow(parent, entry[0], entry[1], {
        copyable: COPYABLE_ROWS.has(entry[0]),
      }),
    );
  }

  // When running in RPC chain mode, ask the live ws-provider which URI
  // it actually connected to. polkadot-api rotates across the curated
  // candidate list on failure, so the first entry of the config array
  // may not be the node currently answering. Lazy-imported so the
  // resolver bundle (polkadot-api and ws-provider) isn't pulled into the
  // popover's own chunk. By the time the popover opens under RPC mode,
  // `@dotli/resolver/rpc-resolve` is already warm because host main
  // imported it to resolve the name. Both the DOM row and the base
  // snapshot are updated so the Share-diagnostic export stays honest.
  if (getBackend() === "rpc-gateway") {
    void import("@dotli/resolver/rpc-resolve").then(
      ({ getConnectedAssetHubRpcEndpoint }) => {
        const live = getConnectedAssetHubRpcEndpoint();
        if (live === null) {
          return;
        }
        rowHandles.get("AssetHub node")?.update(live);
        const row = base.find((r) => r[0] === "AssetHub node");
        if (row !== undefined) {
          row[1] = live;
        }
      },
    );
  }

  // Version is static and cheap. Block numbers are async so the rows start
  // with an ellipsis placeholder and get swapped in when `chainConnect`
  // rounds-trip back with a finalized-block header. When the user is on
  // the RPC chain backend, smoldot isn't running, so hide the per-chain
  // block rows entirely (the endpoints already appear under Chain) and
  // keep only the smoldot version so the dependency is still visible.
  const smoldotInfo: SmoldotInfo = {
    version: buildSmoldotVersionLabel(),
    blocks: { relay: "…", assetHub: "…", people: "…" },
  };
  const smoldotActive = getBackend() !== "rpc-gateway";
  appendSectionHeader(parent, "@smoldot");
  renderInfoRow(parent, "smoldot", smoldotInfo.version);
  if (smoldotActive) {
    const relayRow = renderInfoRow(parent, "Relay Chain", "…");
    const assetHubRow = renderInfoRow(parent, "Asset Hub", "…");
    const peopleRow = renderInfoRow(parent, "People Chain", "…");

    // Fire all queries. They update their own rows and the shared snapshot
    // (so the "Share diagnostic" button captures whatever resolved in time).
    const cfg = getActiveServicesConfig();
    void queryFinalizedBlock(cfg.relay.genesis).then((n) => {
      const v = formatBlock(n);
      relayRow.update(v);
      smoldotInfo.blocks.relay = v;
    });
    void queryFinalizedBlock(cfg.assethub.genesis).then((n) => {
      const v = formatBlock(n);
      assetHubRow.update(v);
      smoldotInfo.blocks.assetHub = v;
    });
    void queryFinalizedBlock(cfg.people.genesis).then((n) => {
      const v = formatBlock(n);
      peopleRow.update(v);
      smoldotInfo.blocks.people = v;
    });
  } else {
    // Keep the snapshot tagged as n/a so the Share-diagnostic report is
    // coherent: smoldot wasn't consulted, don't claim a block height.
    smoldotInfo.blocks.relay = "n/a";
    smoldotInfo.blocks.assetHub = "n/a";
    smoldotInfo.blocks.people = "n/a";
  }

  // The unscoped `polkadot-api` package lives in the same visual section as
  // `@polkadot-api/*`. Same ecosystem, same release cadence, users expect
  // to see it with its siblings rather than at the top of the popover.
  const polkadotApi: { name: string; version: string }[] = [];
  if (typeof __POLKADOT_API_VERSION__ === "string") {
    polkadotApi.push({
      name: "polkadot-api",
      version: __POLKADOT_API_VERSION__,
    });
  }
  if (typeof __POLKADOT_API_VERSIONS__ !== "undefined") {
    polkadotApi.push(...__POLKADOT_API_VERSIONS__);
  }

  // @novasamatech/* versions move in lockstep, so showing every single
  // package is noise. Keep only the two that are independently meaningful:
  // host-api (the host runtime) and sdk-statement (the statement store
  // client). Everything else in the scope tracks host-api's version.
  const NOVASAMATECH_ALLOWLIST = new Set([
    "@novasamatech/host-api",
    "@novasamatech/sdk-statement",
  ]);
  const novasamatech = (
    typeof __NOVASAMATECH_VERSIONS__ === "undefined"
      ? []
      : __NOVASAMATECH_VERSIONS__
  ).filter((p) => NOVASAMATECH_ALLOWLIST.has(p.name));

  if (polkadotApi.length > 0) {
    appendSectionHeader(parent, "@polkadot-api");
    for (const pkg of polkadotApi) {
      renderInfoRow(parent, pkg.name, pkg.version);
    }
  }
  if (novasamatech.length > 0) {
    appendSectionHeader(parent, "@triangle-sdk");
    for (const pkg of novasamatech) {
      renderInfoRow(parent, pkg.name, pkg.version);
    }
  }

  const actionsRow = document.createElement("div");
  actionsRow.className = "mode-cache-row mode-diag-links-row";

  const shareBtn = document.createElement("button");
  shareBtn.type = "button";
  shareBtn.className = "mode-clear-btn";
  shareBtn.textContent = "Share diagnostic";
  shareBtn.title =
    "Open a new issue on paritytech/dotli pre-filled with these diagnostics";
  shareBtn.addEventListener("click", () => {
    const report = formatDiagnosticsReport(
      base,
      smoldotInfo,
      polkadotApi,
      novasamatech,
    );
    const body = [
      "<!-- Describe the issue above this line; the diagnostics below are auto-filled. -->",
      "",
      "## Diagnostics",
      "",
      "```",
      report,
      "```",
    ].join("\n");
    const url = new URL("https://github.com/paritytech/dotli/issues/new");
    url.searchParams.set("body", body);
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  });

  const debugOn = isTruapiDebugEnabled();
  const debugBtn = document.createElement("button");
  debugBtn.type = "button";
  debugBtn.className = "mode-clear-btn";
  debugBtn.textContent = debugOn ? "Exit debug mode" : "Open in debug mode";
  debugBtn.title = debugOn
    ? "Reload this tab with the TrUAPI debug panel disabled"
    : "Reload this tab with the TrUAPI debug panel enabled (off again on tab close)";
  debugBtn.addEventListener("click", () => {
    const url = new URL(window.location.href);
    url.searchParams.set("debug", debugOn ? "off" : "true");
    window.location.assign(url.toString());
  });

  actionsRow.appendChild(shareBtn);
  actionsRow.appendChild(debugBtn);
  parent.appendChild(actionsRow);
}

function isTruapiDebugEnabled(): boolean {
  try {
    return sessionStorage.getItem("dotli:truapi-debug") === "1";
  } catch {
    // sessionStorage may be unavailable in exotic environments (Safari
    // private mode). Default to "not in debug mode".
    return false;
  }
}

/** Flatten the diagnostics tree into a plain-text block that reads cleanly
 *  both inside a GitHub issue code block and in a Slack message.
 *
 *  Structure (one blank line between sections):
 *    1. Base rows (Site, Build, Chain[, Worker|RPC Node], Content, Browser)
 *    2. Cache: every toggle as on/off. Sourced from persisted settings
 *              so the snapshot matches what's actually live right now.
 *    3. Permissions: per-product, omitted on landing where we don't have
 *                    a scoped label to query.
 *    4. Packages: flat list of smoldot, polkadot-api, and novasamatech. The
 *                 live block heights from the @smoldot popover section
 *                 aren't included here because they're noise in a bug
 *                 report. The popover already shows them live. */
function formatDiagnosticsReport(
  base: [label: string, value: string][],
  smoldot: SmoldotInfo,
  polkadotApi: { name: string; version: string }[],
  novasamatech: { name: string; version: string }[],
): string {
  const lines: string[] = [];
  for (const [k, v] of base) {
    lines.push(`${k}: ${v}`);
  }

  // Cache
  const cache = getCacheSettings();
  lines.push(
    "",
    "Cache:",
    `  dotNS cache: ${cache.skipCidCache ? "off" : "on"}`,
    `  Archive cache: ${cache.skipArchiveCache ? "off" : "on"}`,
    `  Worker cache: ${cache.skipWorkerCache ? "off" : "on"}`,
  );

  // Permissions, only when we know which product label to scope against.
  if (currentProductLabel !== null) {
    lines.push("", "Permissions:");
    for (const perm of ALL_PERMISSIONS) {
      const status = getPermissionStatus(currentProductLabel, perm.name);
      lines.push(`  ${perm.label}: ${status === "granted" ? "on" : "off"}`);
    }
  }

  // Packages, one flat list. smoldot leads because it's the heaviest
  // dependency and the one most issues are ultimately about.
  lines.push("", "Packages:", `  smoldot: ${smoldot.version}`);
  for (const p of polkadotApi) {
    lines.push(`  ${p.name}: ${p.version}`);
  }
  for (const p of novasamatech) {
    lines.push(`  ${p.name}: ${p.version}`);
  }
  return lines.join("\n");
}

function buildBaseDiagnosticsRows(): [label: string, value: string][] {
  const version =
    typeof __DOTLI_VERSION__ === "string" ? __DOTLI_VERSION__ : "0.0.0";
  const sha = (import.meta.env.VITE_COMMIT_SHA as string | undefined) ?? "dev";

  const backend = getBackend();
  const network = getNetwork();

  const rows: [string, string][] = [
    // `location.host` includes the port when non-default. Useful on
    // localhost (`hackme3.localhost:5173`), transparent on production
    // (`hackme3.dot.li`).
    ["Site", window.location.host],
    ["Build", `${version} (${shortSha(sha)})`],
    ["Network", NETWORK_NAME_TO_SERVICES_CONFIG[network].label],
    ["Backend", backendLabel(backend)],
  ];

  // Sub-row attached to the Backend row:
  //   - smoldot-shared-worker: "Worker" label and build SHA. The SharedWorker
  //     is a cached script. If it's running an older bundle than the current
  //     page, this SHA diverges from Build, which is the tell-tale for a stale
  //     worker. (Today the Worker ships embedded in the same bundle, so
  //     the two match. The row still lets us spot a divergence in the
  //     field.)
  //   - smoldot-direct: no sub-row. smoldot is torn down every page load.
  //   - rpc-gateway: both WSS endpoints (Relay and Asset Hub). The curated
  //     lists are candidate endpoints. polkadot-api's ws-provider rotates
  //     on failure, so `renderDiagnostics` later replaces the Asset Hub
  //     entry with the one the provider is actually connected to. Relay
  //     isn't dialed at all in rpc mode today (dotNS is Asset Hub only),
  //     so it just shows the first candidate for reference.
  if (backend === "smoldot-shared-worker") {
    if (typeof SharedWorker === "undefined") {
      rows.push(["Worker", "unavailable"]);
    } else {
      rows.push(["Worker", shortSha(sha)]);
    }
  } else if (backend === "rpc-gateway") {
    const cfg = getActiveServicesConfig();
    rows.push(["Relay node", cfg.relay.rpcs[0] ?? "n/a"]);
    rows.push(["AssetHub node", cfg.assethub.rpcs[0] ?? "n/a"]);
    rows.push(["Bulletin Node", cfg.bulletin.rpcs[0] ?? "n/a"]);
  }

  // Product manifest snapshot.
  const root = getActiveRootManifest();
  if (root !== null) {
    rows.push(["Manifest", `v${String(root.schemaVersion)}`]);
  }
  const app = getActiveAppManifest();
  if (app !== null) {
    rows.push(["App version", formatAppVersion(app.appVersion)]);
  }

  rows.push(["Browser", summarizeUserAgent(navigator.userAgent)]);
  return rows;
}

function backendLabel(b: Backend): string {
  switch (b) {
    case "smoldot-shared-worker":
      return "Light Client Shared";
    case "smoldot-direct":
      return "Light Client Per-Tab";
    case "rpc-gateway":
      return "Trusted Providers";
  }
}

interface SmoldotInfo {
  /** Human-facing version label, e.g. "3.0.0 (c33c647)". */
  version: string;
  /** Mutable block readouts for the share report. */
  blocks: { relay: string; assetHub: string; people: string };
}

function buildSmoldotVersionLabel(): string {
  const smoldot =
    typeof __SMOLDOT_VERSION__ === "string" ? __SMOLDOT_VERSION__ : "unknown";
  // Smoldot's upstream commit is resolved at build time by the host's
  // vite.config against paritytech/smoldot's release tags. Degrades to
  // just `<version>` when the lookup wasn't possible (offline build).
  const commit =
    typeof __SMOLDOT_COMMIT__ === "string" && __SMOLDOT_COMMIT__.length > 0
      ? ` (${shortSha(__SMOLDOT_COMMIT__)})`
      : "";
  return `${smoldot}${commit}`;
}

/**
 * Query the finalized block number for a given chain through the protocol
 * iframe's `chainConnect` bridge. Works across all chain backends:
 *   - smoldot-shared-worker / smoldot-direct: goes through smoldot
 *   - rpc: goes through the curated WSS endpoint
 *
 * Returns `null` if the chain isn't supported by the active backend (e.g.
 * asking for relay in rpc mode, which only supports Asset Hub) or if the
 * query doesn't resolve within the timeout. The heavy `polkadot-api` import
 * stays dynamic so opening the popover is cheap when the user doesn't care
 * about blocks.
 */
async function queryFinalizedBlock(
  genesisHash: string,
): Promise<number | null> {
  try {
    if (!isRemoteChainSupported(genesisHash)) {
      return null;
    }
    const provider = createRemoteChainProvider(genesisHash);
    if (provider === null) {
      return null;
    }
    const papi = await import("polkadot-api");
    const client = papi.createClient(provider);
    try {
      const block = await Promise.race([
        client.getFinalizedBlock(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("timeout"));
          }, 10_000);
        }),
      ]);
      return block.number;
    } finally {
      client.destroy();
    }
  } catch {
    return null;
  }
}

function formatBlock(n: number | null): string {
  return n === null ? "n/a" : `#${n.toLocaleString("en-US")}`;
}

function shortSha(sha: string): string {
  if (sha === "dev" || sha.length <= 7) {
    return sha;
  }
  return sha.slice(0, 7);
}

/**
 * Turn a long `navigator.userAgent` string into something compact like
 * "Chrome 147 (macOS)". Heuristic, not a replacement for a real UA parser.
 * Good enough for a debug row that the user can still click-to-copy the
 * full value (the row shows the short version but the UA is stable enough
 * that engineers can recognize the brand without the full payload).
 */
function summarizeUserAgent(ua: string): string {
  let browser = "Unknown";
  const chromeMatch = /(Chrome|CriOS)\/(\d+)/.exec(ua);
  const firefoxMatch = /Firefox\/(\d+)/.exec(ua);
  const safariMatch = /Version\/(\d+)[^)]+Safari/.exec(ua);
  const edgeMatch = /Edg\/(\d+)/.exec(ua);
  if (edgeMatch) {
    browser = `Edge ${edgeMatch[1]}`;
  } else if (firefoxMatch) {
    browser = `Firefox ${firefoxMatch[1]}`;
  } else if (chromeMatch) {
    browser = `Chrome ${chromeMatch[2]}`;
  } else if (safariMatch) {
    browser = `Safari ${safariMatch[1]}`;
  }

  let os = "Unknown";
  if (ua.includes("Mac OS X") || ua.includes("Macintosh")) {
    os = "macOS";
  } else if (ua.includes("Windows")) {
    os = "Windows";
  } else if (ua.includes("Android")) {
    os = "Android";
  } else if (ua.includes("iPhone") || ua.includes("iPad")) {
    os = "iOS";
  } else if (ua.includes("Linux")) {
    os = "Linux";
  }

  return `${browser} (${os})`;
}

/**
 * Static label/value row used by the Diagnostics block. No click-to-copy.
 * The "Share diagnostic" button at the bottom exports the full report at
 * once, so per-row copy would just be noise.
 *
 * Returns an `update(value)` handle so callers can fill the row later when
 * an async lookup finishes (used by the @smoldot block queries).
 */
interface InfoRowHandle {
  update: (value: string) => void;
}
function renderInfoRow(
  parent: HTMLElement,
  label: string,
  value: string,
  options: { copyable?: boolean } = {},
): InfoRowHandle {
  const row = document.createElement("div");
  row.className = "mode-endpoint-row mode-info-row";
  const labelEl = document.createElement("span");
  labelEl.className = "mode-endpoint-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("code");
  valueEl.className = "mode-endpoint-value";
  valueEl.textContent = value;
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  parent.appendChild(row);

  let currentValue = value;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  if (options.copyable === true) {
    row.classList.add("mode-info-row-copyable");
    row.title = `Click to copy ${label}`;
    row.addEventListener("click", () => {
      if (
        currentValue === "" ||
        currentValue === "…" ||
        currentValue === "n/a"
      ) {
        return;
      }
      void navigator.clipboard.writeText(currentValue).then(() => {
        valueEl.textContent = "Copied";
        row.classList.add("copied");
        if (copiedTimer !== undefined) {
          clearTimeout(copiedTimer);
        }
        copiedTimer = setTimeout(() => {
          valueEl.textContent = currentValue;
          row.classList.remove("copied");
          copiedTimer = undefined;
        }, 1000);
      });
    });
  }

  return {
    update: (next) => {
      currentValue = next;
      if (copiedTimer === undefined) {
        valueEl.textContent = next;
      }
    },
  };
}

function renderChainRadio(
  parent: HTMLElement,
  value: Backend,
  label: string,
  description: string,
  current: Backend,
  disabled: boolean,
  onSelect: (next: Backend) => void,
): void {
  const row = buildRadioRow(`dotli-backend-${value}`, "dotli-backend", {
    value,
    label,
    description,
    selected: value === current,
    disabled,
  });
  row.querySelector("input")?.addEventListener("change", () => {
    onSelect(value);
  });
  parent.appendChild(row);
}

function renderNetworkRadio(
  parent: HTMLElement,
  value: Network,
  label: string,
  description: string,
  current: Network,
  onSelect: (next: Network) => void,
): void {
  const row = buildRadioRow(`dotli-network-${value}`, "dotli-network", {
    value,
    label,
    description,
    selected: value === current,
  });
  row.querySelector("input")?.addEventListener("change", () => {
    onSelect(value);
  });
  parent.appendChild(row);
}

function buildRadioRow(
  _id: string,
  name: string,
  opts: {
    value: string;
    label: string;
    description: string;
    selected: boolean;
    disabled?: boolean;
  },
): HTMLLabelElement {
  const row = document.createElement("label");
  const disabled = opts.disabled === true;
  row.className = `mode-radio-row${opts.selected ? " selected" : ""}${disabled ? " disabled" : ""}`;

  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = name;
  radio.value = opts.value;
  radio.checked = opts.selected;
  radio.disabled = disabled;
  radio.className = "mode-radio-input";
  row.appendChild(radio);

  const dot = document.createElement("span");
  dot.className = "mode-radio-dot";
  row.appendChild(dot);

  const text = document.createElement("span");
  text.className = "mode-radio-text";
  const labelEl = document.createElement("span");
  labelEl.className = "mode-radio-label";
  labelEl.textContent = opts.label;
  const descEl = document.createElement("span");
  descEl.className = "mode-radio-desc";
  descEl.textContent = opts.description;
  text.append(labelEl, descEl);
  row.appendChild(text);

  return row;
}

function appendDivider(parent: HTMLElement = modePopoverContent): void {
  const divider = document.createElement("div");
  divider.className = "mode-popover-divider";
  parent.appendChild(divider);
}

function renderCacheToggle(
  parent: HTMLElement,
  label: string,
  checked: boolean,
  onChange: (enabled: boolean) => void,
): void {
  const row = document.createElement("div");
  row.className = "mode-cache-row";

  const nameEl = document.createElement("span");
  nameEl.className = "mode-cache-label";
  nameEl.textContent = label;
  row.appendChild(nameEl);

  const toggle = document.createElement("button");
  toggle.setAttribute("role", "switch");

  const track = document.createElement("span");
  track.className = "permissions-toggle-track";
  const knob = document.createElement("span");
  knob.className = "permissions-toggle-knob";
  track.appendChild(knob);
  toggle.appendChild(track);

  // The toggle owns its own on/off state locally. The `renderModePopover`
  // caller doesn't re-render the cache section on change (only chain/content
  // groups re-render), so the button has to flip its own class and aria
  // attribute or the UI stays stuck on its initial value.
  let current = checked;
  const paint = (): void => {
    toggle.className = `permissions-popover-toggle ${current ? "on" : ""}`;
    toggle.setAttribute("aria-checked", String(current));
  };
  paint();

  toggle.addEventListener("click", () => {
    current = !current;
    paint();
    onChange(current);
  });

  row.appendChild(toggle);
  parent.appendChild(row);
}

function openModal(reason?: string, label?: string): void {
  modalQr.innerHTML = `<div class="spinner"></div>`;
  // Mobile leads with the deeplink button. The QR toggle swaps this copy later.
  modalHint.textContent = isMobileDevice()
    ? "Sign in with the Polkadot app on this device"
    : "Scan with Polkadot Mobile to connect";
  // A bare "localhost:<port>" label means dotli is in localhost-proxy
  // mode rendering a local dev server directly (apps/host/src/main.ts
  // localhost-proxy branch). Show it as-is. Deployed dotNs products
  // served via `<label>.localhost:<port>` still pass through as the bare
  // label and get the ".dot" suffix.
  let productLabel = "";
  if (label !== undefined && label.length > 0) {
    productLabel = label.startsWith("localhost:") ? label : `${label}.dot`;
  }
  modalTitle.innerHTML =
    productLabel.length > 0
      ? `${escapeHtml(productLabel)} is asking you <span class="auth-modal-title-nowrap">to sign in</span>`
      : "Login with Polkadot Mobile";
  if (reason !== undefined && reason.length > 0) {
    modalReason.textContent = reason;
    modalReason.hidden = false;
  } else {
    modalReason.textContent = "";
    modalReason.hidden = true;
  }
  modalBackdrop.classList.add("open");
}

function closeModal(): void {
  modalBackdrop.classList.remove("open");

  if (authMod) {
    const state = authMod.getAuthState();
    // Only abort during pairing or error. Let attestation continue in background
    if (state.status === "pairing" || state.status === "error") {
      authMod.abortPairing();
    }
  }
}
