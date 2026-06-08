// dot.li — Top bar UI
//
// Manages the auth button, QR pairing modal, and user popover.
// All plain DOM manipulation — no framework.
//
// Login/session state is owned by the shared Rust TrUAPI core.

import { log } from "@dotli/shared/log";
import { escapeHtml } from "@dotli/shared/html";
import {
  PASEO_RELAY_GENESIS,
  ASSET_HUB_PASEO_GENESIS,
} from "@dotli/config/config";
import {
  getCacheSettings,
  setCacheSettings,
  getChainBackend,
  setChainBackend,
  getContentBackend,
  setContentBackend,
  isVerifiedSession,
  type ChainBackend,
  type ContentBackend,
  type CacheSettings,
} from "@dotli/config/mode";
import {
  getActiveAssetHubRpcEndpoints,
  getActivePaseoRelayRpcEndpoints,
} from "@dotli/config/endpoints";
import {
  ALL_PERMISSIONS,
  getPermissionStatus,
  hasAnyGrant,
  isDevicePermission,
  resetPermission,
  setPermissionStatus,
  type PermissionStatus,
} from "./permissions";
import type { TrUApiPairingRequest } from "./host-callbacks/Pairing";

// ── DOM refs ───────────────────────────────────────────────

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

// Hexagon SVG for the logged-out state
// User icon for the logged-out state
const USER_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

// Track the current QR payload to prevent stale canvas appends
let currentQrPayload: string | null = null;
let activeTruapiPairingCancel: (() => void) | null = null;
let truapiSessionConnected = false;

// ── Theme Toggle ──────────────────────────────────────────

function getStoredTheme(): "light" | "dark" {
  const stored = localStorage.getItem("dotli-theme");
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return "dark";
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.setAttribute("data-theme", theme);
  const sunIcon = document.getElementById("theme-icon-sun");
  const moonIcon = document.getElementById("theme-icon-moon");
  if (sunIcon !== null && moonIcon !== null) {
    // In dark mode show moon (click to go light), in light mode show sun (click to go dark)
    sunIcon.style.display = theme === "light" ? "block" : "none";
    moonIcon.style.display = theme === "dark" ? "block" : "none";
  }
  // Notify render.ts to re-resolve scheme-specific theme-color
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

// ── Init ───────────────────────────────────────────────────

export function initTopBar(): void {
  authButton = getElement("auth-button");
  modalBackdrop = getElement("auth-modal-backdrop");
  modalTitle = getElement("auth-modal-title");
  modalQr = getElement("auth-modal-qr");
  modalReason = getElement("auth-modal-reason");
  modalClose = getElement("auth-modal-close");
  userPopover = getElement("user-popover");
  userPopoverUsername = getElement("user-popover-username");
  userPopoverDisconnect = getElement("user-popover-disconnect");

  // Auth button: opens modal (logged out) or popover (logged in)
  authButton.addEventListener("click", handleAuthButtonClick);

  // Modal close button
  modalClose.addEventListener("click", () => {
    closeModal();
  });

  // Clicking backdrop (outside modal) closes modal
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      closeModal();
    }
  });

  // Disconnect button
  userPopoverDisconnect.addEventListener("click", handleDisconnect);

  window.addEventListener("dotli:truapi-pairing", (e: Event) => {
    const { deeplink, label, cancel } = (e as CustomEvent<TrUApiPairingRequest>)
      .detail;
    activeTruapiPairingCancel?.();
    activeTruapiPairingCancel = cancel;
    openModal(undefined, label);
    renderPairing(deeplink);
  });

  window.addEventListener("dotli:truapi-session-state", (e: Event) => {
    const { connected } = (e as CustomEvent<{ connected: boolean }>).detail;
    truapiSessionConnected = connected;
    activeTruapiPairingCancel = null;
    closeModal({ skipTruapiCancel: true });
    if (connected) {
      renderTruapiLoggedIn();
    } else {
      renderLoggedOut();
    }
  });

  window.addEventListener("dotli:truapi-login-error", (e: Event) => {
    const { message } = (e as CustomEvent<{ message: string }>).detail;
    openModal(undefined, currentProductLabel ?? undefined);
    renderError(message);
  });

  // Close popovers when clicking outside
  document.addEventListener("click", (e) => {
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
}

// ── Render ─────────────────────────────────────────────────

function renderLoggedOut(): void {
  authButton.innerHTML = USER_SVG;
  authButton.title = "Login with Polkadot Mobile";
  window.dispatchEvent(new Event("dotli:logged-out"));
}

function renderTruapiLoggedIn(): void {
  authButton.innerHTML = `<div class="user-badge">TU</div>`;
  authButton.title = "Account";
  userPopoverUsername.textContent = "Connected with Polkadot Mobile";
  window.dispatchEvent(new Event("dotli:authenticated"));
}

function renderPairing(payload: string): void {
  currentQrPayload = payload;

  if (!payload) {
    // Initial state — show spinner
    modalQr.innerHTML = `<div class="spinner"></div>`;
    return;
  }

  // Render QR code (lazy-load qrcode lib, guard against stale appends)
  const canvas = document.createElement("canvas");
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
      modalQr.appendChild(canvas);
    })
    .catch((err: unknown) => {
      log.error("[dot.li] QR render failed:", err);
    });
}

function renderError(message: string): void {
  const container = document.createElement("div");
  container.style.textAlign = "center";

  const msg = document.createElement("p");
  msg.className = "auth-modal-error";
  msg.textContent = message;
  container.appendChild(msg);

  const retry = document.createElement("button");
  retry.className = "auth-modal-retry";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => {
    requestTruapiLogin();
  });
  container.appendChild(retry);

  modalQr.innerHTML = "";
  modalQr.appendChild(container);
}

// ── Handlers ───────────────────────────────────────────────

function handleAuthButtonClick(): void {
  if (truapiSessionConnected) {
    userPopover.classList.toggle("open");
  } else {
    requestTruapiLogin();
  }
}

function handleDisconnect(): void {
  userPopover.classList.remove("open");
  requestTruapiDisconnect();
}

export function requestTruapiDisconnect(): void {
  window.dispatchEvent(new Event("dotli:truapi-disconnect-request"));
}

function requestTruapiLogin(): void {
  window.dispatchEvent(
    new CustomEvent("dotli:truapi-login-request", {
      detail: {
        label: currentProductLabel ?? undefined,
      },
    }),
  );
}

// ── Permissions ───────────────────────────────────────────

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
};

function initPermissions(): void {
  permissionsButton = getElement("permissions-button");
  permissionsPopover = getElement("permissions-popover");
  permissionsPopoverList = getElement("permissions-popover-list");
  // Backdrop is optional — older host shells that haven't added the element
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
    hint.textContent =
      "Wait for the app to finish loading to change its permissions.";
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

// ── Resolution Mode Toggle ───────────────────────────────────

function initModeToggle(): void {
  modeButton = getElement("mode-button");
  modePopover = getElement("mode-popover");
  modePopoverContent = getElement("mode-popover-content");
  // Backdrop is optional — older host shells that haven't added the element
  // still work, the popover just doesn't get a modal overlay there.
  modePopoverBackdrop = document.getElementById("mode-popover-backdrop");

  // Show the "trusted provider" indicator on the settings button whenever
  // the session is not fully verified — i.e. chain=rpc or content=gateway
  // on either axis. The rule is owned by `isVerifiedSession` so this
  // button and the host shield can never disagree on trust posture.
  modeButton.classList.toggle(
    "gateway-mode",
    !isVerifiedSession(getChainBackend(), getContentBackend()),
  );

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
 * Open the resolution-mode popover programmatically, e.g. from a slow-path
 * "Adjust mode" affordance instead of silently swapping modes behind the
 * user's back. Safe to call before `initTopBar()` — falls through silently
 * if the DOM isn't ready yet.
 */
export function openModePopover(): void {
  try {
    const popover = document.getElementById("mode-popover");
    if (popover === null) {
      return;
    }
    if (!popover.classList.contains("open")) {
      popover.classList.add("open");
      const backdrop = document.getElementById("mode-popover-backdrop");
      backdrop?.classList.add("open");
      renderModePopover();
    }
    // eslint-disable-next-line no-restricted-syntax -- DOM not available (SSR / test harness); caller is just asking to open a popover, there's nothing to do.
  } catch {
    /* no DOM — nothing to open */
  }
}

/**
 * Draft of everything the popover can change. Controls mutate this; nothing
 * touches localStorage or reloads the page until the user clicks Save &
 * Apply. Closing the popover throws the draft away — the next open re-reads
 * persisted state from scratch, so partial changes never leak.
 */
interface ModeDraft {
  chain: ChainBackend;
  content: ContentBackend;
  cache: CacheSettings;
}

function renderModePopover(): void {
  // Two-column grid. Left: chain / content / cache. Right: endpoints /
  // diagnostics. Save & Apply and the footer span both columns at the
  // bottom. Collapses to a single column on narrow viewports (CSS media
  // query on `.mode-popover-columns`).
  const parent = modePopoverContent;
  parent.innerHTML = "";

  const persisted: ModeDraft = {
    chain: getChainBackend(),
    content: getContentBackend(),
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

  // ── Left column: Chain / Content / Cache ──
  appendSectionHeader(leftCol, "Chain");
  const chainChoices: [ChainBackend, string, string][] = [
    [
      "smoldot-shared-worker",
      "Light Client (smoldot worker)",
      "Light client shared across tabs (recommended)",
    ],
    ["smoldot-direct", "Light Client (smoldot direct)", "Light client per tab"],
    ["rpc", "RPC Node (trusted provider)", "Direct JSON-RPC to a known node"],
  ];
  const chainGroup = document.createElement("div");
  leftCol.appendChild(chainGroup);
  const rerenderChain = (): void => {
    chainGroup.innerHTML = "";
    for (const [value, label, desc] of chainChoices) {
      renderChainRadio(chainGroup, value, label, desc, draft.chain, (next) => {
        draft.chain = next;
        rerenderChain();
        syncApply();
      });
    }
  };
  rerenderChain();

  appendDivider(leftCol);
  appendSectionHeader(leftCol, "Content");
  const contentChoices: [ContentBackend, string, string][] = [
    [
      "p2p-helia",
      "P2P (bulletin bitswap)",
      "Fetch blocks from configured peers",
    ],
    [
      "ipfs-gateway",
      "Gateway (trusted provider)",
      "HTTP fetch from trusted gateway",
    ],
  ];
  const contentGroup = document.createElement("div");
  leftCol.appendChild(contentGroup);
  const rerenderContent = (): void => {
    contentGroup.innerHTML = "";
    for (const [value, label, desc] of contentChoices) {
      renderContentRadio(
        contentGroup,
        value,
        label,
        desc,
        draft.content,
        (next) => {
          draft.content = next;
          rerenderContent();
          syncApply();
        },
      );
    }
  };
  rerenderContent();

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
  // (smoldot chain DB + polkadot-api caches) before initialisation — i.e.
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
  // because conceptually it's the same capability as the cache toggles —
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
    // Apply the current persisted settings (no-op as a diff) so the reset
    // path always re-seeds localStorage with a valid baseline.
    void applyAndReset(persisted, persisted);
  });
  clearRow.appendChild(clearBtn);
  leftCol.appendChild(clearRow);

  // ── Right column: Diagnostics only ──
  appendSectionHeader(rightCol, "Diagnostics");
  renderDiagnostics(rightCol);

  // ── Save & Apply (full width) ──
  appendDivider();
  const applyRow = document.createElement("div");
  applyRow.className = "mode-cache-row mode-apply-row";
  const applyBtn = document.createElement("button");
  applyBtn.className = "mode-clear-btn";
  applyRow.appendChild(applyBtn);
  parent.appendChild(applyRow);

  // Warning text: changing any backend/cache option triggers a full wipe of
  // host + protocol + sandbox state on reload. Shown only when the draft is
  // dirty so the idle popover isn't noisy.
  const resetWarning = document.createElement("p");
  resetWarning.className = "mode-apply-warning";
  resetWarning.textContent =
    "Applying will wipe all cached data across every origin.";
  parent.appendChild(resetWarning);

  syncApply = (): void => {
    const dirty =
      draft.chain !== persisted.chain ||
      draft.content !== persisted.content ||
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
 * Apply the pending draft and wipe every piece of persisted state we own on
 * this origin before reloading. The reload path also signals the protocol
 * iframe (host.dot.li) and the sandbox iframe (cid.app.dot.li) to purge
 * their origins — each origin has to wipe itself, we can't reach across.
 *
 * Order matters:
 *   1. Persist the new settings (so the re-apply after wipe uses them).
 *   2. Mark cross-origin reset flags in sessionStorage (host main + bridge
 *      consume these on the next boot).
 *   3. Wipe host-origin state. After wipe we re-write just the settings +
 *      the cross-origin flags so the next boot has both the user's choice
 *      and the "please purge yourselves" signal intact.
 *   4. Reload.
 */
async function applyAndReset(
  draft: ModeDraft,
  persisted: ModeDraft,
): Promise<void> {
  try {
    // Snapshot the theme so we don't yank the user into a different colour
    // scheme just because they changed the resolution mode.
    const theme = localStorage.getItem("dotli-theme");

    if (draft.chain !== persisted.chain) {
      setChainBackend(draft.chain);
    }
    if (draft.content !== persisted.content) {
      setContentBackend(draft.content);
    }
    if (
      draft.cache.skipCidCache !== persisted.cache.skipCidCache ||
      draft.cache.skipArchiveCache !== persisted.cache.skipArchiveCache ||
      draft.cache.skipWorkerCache !== persisted.cache.skipWorkerCache
    ) {
      setCacheSettings(draft.cache);
    }

    await wipeOriginState();

    // Re-apply the user's choice + theme after wipe.
    setChainBackend(draft.chain);
    setContentBackend(draft.content);
    setCacheSettings(draft.cache);
    if (theme === "light" || theme === "dark") {
      localStorage.setItem("dotli-theme", theme);
    }

    // Cross-origin purge signals — consumed by host main (protocol iframe)
    // and the bridge (sandbox iframe) on the next boot.
    try {
      sessionStorage.setItem("dotli:pending-reset:protocol", "1");
      sessionStorage.setItem("dotli:pending-reset:sandbox", "1");
      // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable (Safari private mode); cross-origin purges are best-effort, reload below is unconditional.
    } catch {
      /* sessionStorage unavailable — cross-origin purges skipped */
    }
  } finally {
    window.location.reload();
  }
}

/**
 * Wipe every persisted store on this origin: IndexedDB, CacheStorage, all
 * service worker registrations, localStorage, sessionStorage.
 *
 * Best-effort — some browsers don't expose `indexedDB.databases()`
 * (historically Firefox, Safari pre-17). On those we can't proactively list
 * + delete; the user will get a partially clean baseline but the mode
 * change still takes effect via the reloaded settings.
 */
async function wipeOriginState(): Promise<void> {
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
// present in practice; `undefined` fallbacks are defensive for tests and
// for any future caller that imports this module from a different bundle.
declare const __DOTLI_VERSION__: string | undefined;
declare const __SMOLDOT_VERSION__: string | undefined;
declare const __SMOLDOT_COMMIT__: string | undefined;
declare const __POLKADOT_API_VERSION__: string | undefined;
declare const __POLKADOT_API_VERSIONS__:
  | { name: string; version: string }[]
  | undefined;

/**
 * Render the Diagnostics block at the bottom of the settings popover. Rows
 * are static (no click-to-copy) — the "Share diagnostic" button at the end
 * exports the whole block at once, so individual-row copy would be noise.
 *
 * Values come from places that are cheap to read synchronously so the
 * popover doesn't pop open with a spinner. "unknown" is a valid value;
 * don't over-engineer fallbacks.
 */
function renderDiagnostics(parent: HTMLElement): void {
  const base = buildBaseDiagnosticsRows();
  const rowHandles = new Map<string, InfoRowHandle>();
  for (const entry of base) {
    rowHandles.set(entry[0], renderInfoRow(parent, entry[0], entry[1]));
  }

  // When running in RPC chain mode, ask the live ws-provider which URI
  // it actually connected to — polkadot-api rotates across the curated
  // candidate list on failure, so the first entry of the config array
  // may not be the node currently answering. Lazy-imported so the
  // resolver bundle (polkadot-api + ws-provider) isn't pulled into the
  // popover's own chunk; by the time the popover opens under RPC mode,
  // `@dotli/resolver/rpc-resolve` is already warm because host main
  // imported it to resolve the name. Both the DOM row and the base
  // snapshot are updated so the Share-diagnostic export stays honest.
  if (getChainBackend() === "rpc") {
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

  // ── @smoldot ──
  // Version is static + cheap; block numbers are async so the rows start
  // with an ellipsis placeholder and get swapped in when `chainConnect`
  // rounds-trip back with a finalized-block header. When the user is on
  // the RPC chain backend, smoldot isn't running — hide the per-chain
  // block rows entirely (the endpoints already appear under Chain) and
  // keep only the smoldot version so the dependency is still visible.
  const smoldotInfo: SmoldotInfo = {
    version: buildSmoldotVersionLabel(),
    blocks: { relay: "…", assetHub: "…" },
  };
  const smoldotActive = getChainBackend() !== "rpc";
  appendSectionHeader(parent, "@smoldot");
  renderInfoRow(parent, "smoldot", smoldotInfo.version);
  if (smoldotActive) {
    const relayRow = renderInfoRow(parent, "Relay Chain", "…");
    const assetHubRow = renderInfoRow(parent, "Asset Hub", "…");

    // Fire both queries; they update their own rows + the shared snapshot
    // (so the "Share diagnostic" button captures whatever resolved in time).
    void queryFinalizedBlock(PASEO_RELAY_GENESIS).then((n) => {
      const v = formatBlock(n);
      relayRow.update(v);
      smoldotInfo.blocks.relay = v;
    });
    void queryFinalizedBlock(ASSET_HUB_PASEO_GENESIS).then((n) => {
      const v = formatBlock(n);
      assetHubRow.update(v);
      smoldotInfo.blocks.assetHub = v;
    });
  } else {
    // Keep the snapshot tagged as n/a so the Share-diagnostic report is
    // coherent: smoldot wasn't consulted, don't claim a block height.
    smoldotInfo.blocks.relay = "n/a";
    smoldotInfo.blocks.assetHub = "n/a";
  }

  // The unscoped `polkadot-api` package lives in the same visual section as
  // `@polkadot-api/*` — same ecosystem, same release cadence, users expect
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

  if (polkadotApi.length > 0) {
    appendSectionHeader(parent, "@polkadot-api");
    for (const pkg of polkadotApi) {
      renderInfoRow(parent, pkg.name, pkg.version);
    }
  }

  const shareRow = document.createElement("div");
  shareRow.className = "mode-cache-row";
  const shareBtn = document.createElement("button");
  shareBtn.className = "mode-clear-btn";
  shareBtn.textContent = "Share diagnostic";
  shareBtn.title =
    "Open a new issue on paritytech/dotli pre-filled with these diagnostics";
  shareBtn.addEventListener("click", () => {
    const report = formatDiagnosticsReport(
      base,
      smoldotInfo,
      polkadotApi,
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
  shareRow.appendChild(shareBtn);
  parent.appendChild(shareRow);
}

/** Flatten the diagnostics tree into a plain-text block that reads cleanly
 *  both inside a GitHub issue code block and in a Slack message.
 *
 *  Structure (one blank line between sections):
 *    1. Base rows (Site, Build, Chain[, Worker|RPC Node], Content, Browser)
 *    2. Cache   — every toggle as on/off. Sourced from persisted settings
 *                 so the snapshot matches what's actually live right now.
 *    3. Permissions — per-product; omitted on landing where we don't have
 *                     a scoped label to query.
 *    4. Packages — flat list: smoldot + polkadot-api. The live block heights
 *                   from the @smoldot popover section aren't included here
 *                   because they're noise in a bug report; the popover already
 *                   shows them live. */
function formatDiagnosticsReport(
  base: [label: string, value: string][],
  smoldot: SmoldotInfo,
  polkadotApi: { name: string; version: string }[],
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

  // Permissions — only when we know which product label to scope against.
  if (currentProductLabel !== null) {
    lines.push("", "Permissions:");
    for (const perm of ALL_PERMISSIONS) {
      const status = getPermissionStatus(currentProductLabel, perm.name);
      lines.push(`  ${perm.label}: ${status === "granted" ? "on" : "off"}`);
    }
  }

  // Packages — one flat list. smoldot leads because it's the heaviest
  // dependency and the one most issues are ultimately about.
  lines.push("", "Packages:", `  smoldot: ${smoldot.version}`);
  for (const p of polkadotApi) {
    lines.push(`  ${p.name}: ${p.version}`);
  }
  return lines.join("\n");
}

function buildBaseDiagnosticsRows(): [label: string, value: string][] {
  const version =
    typeof __DOTLI_VERSION__ === "string" ? __DOTLI_VERSION__ : "0.0.0";
  const sha = (import.meta.env.VITE_COMMIT_SHA as string | undefined) ?? "dev";

  const chain = getChainBackend();
  const content = getContentBackend();

  const rows: [string, string][] = [
    // `location.host` includes the port when non-default — useful on
    // localhost (`hackme3.localhost:5173`), transparent on production
    // (`hackme3.dot.li`).
    ["Site", window.location.host],
    ["Build", `${version} (${shortSha(sha)})`],
    ["Chain", chainBackendLabel(chain)],
  ];

  // Sub-row attached to the Chain row:
  //   - smoldot-shared-worker: "Worker" + build SHA. The SharedWorker is a
  //     cached script — if it's running an older bundle than the current
  //     page, this SHA diverges from Build, which is the tell-tale for a
  //     stale worker. (Today the Worker ships embedded in the same bundle,
  //     so the two match; the row still lets us spot a divergence in the
  //     field.)
  //   - smoldot-direct: no sub-row; smoldot is torn down every page load.
  //   - rpc: both WSS endpoints (Relay + Asset Hub). The curated lists
  //     are candidate endpoints — polkadot-api's ws-provider rotates
  //     on failure, so `renderDiagnostics` later replaces the Asset Hub
  //     entry with the one the provider is actually connected to.
  //     Relay isn't dialed at all in RPC mode today (dotNS is Asset Hub
  //     only), so it just shows the first candidate for reference.
  if (chain === "smoldot-shared-worker") {
    if (typeof SharedWorker === "undefined") {
      rows.push(["Worker", "unavailable"]);
    } else {
      rows.push(["Worker", shortSha(sha)]);
    }
  } else if (chain === "rpc") {
    const relay = getActivePaseoRelayRpcEndpoints()[0] ?? "n/a";
    const assetHub = getActiveAssetHubRpcEndpoints()[0] ?? "n/a";
    rows.push(["Relay node", relay]);
    rows.push(["AssetHub node", assetHub]);
  }

  rows.push(["Content", contentBackendLabel(content)]);
  rows.push(["Browser", summarizeUserAgent(navigator.userAgent)]);
  return rows;
}

function chainBackendLabel(b: ChainBackend): string {
  switch (b) {
    case "smoldot-shared-worker":
      return "Smoldot Worker";
    case "smoldot-direct":
      return "Smoldot Direct";
    case "rpc":
      return "RPC Node";
  }
}

function contentBackendLabel(b: ContentBackend): string {
  switch (b) {
    case "p2p-helia":
      return "P2P";
    case "ipfs-gateway":
      return "Gateway";
  }
}

interface SmoldotInfo {
  /** Human-facing version label, e.g. "3.0.0 (c33c647)". */
  version: string;
  /** Mutable block readouts for the share report. */
  blocks: { relay: string; assetHub: string };
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
 * query doesn't resolve within the timeout. All imports are dynamic so
 * opening the popover is cheap when the user doesn't care about blocks.
 */
async function queryFinalizedBlock(
  genesisHash: string,
): Promise<number | null> {
  try {
    const [protocolClient, papi] = await Promise.all([
      import("@dotli/protocol/client"),
      import("polkadot-api"),
    ]);
    if (!protocolClient.isRemoteChainSupported(genesisHash)) {
      return null;
    }
    const provider = protocolClient.createRemoteChainProvider(genesisHash);
    if (provider === null) {
      return null;
    }
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
 * "Chrome 147 (macOS)". Heuristic — not a replacement for a real UA parser,
 * good enough for a debug row that the user can still click-to-copy the
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
 * Static label/value row used by the Diagnostics block. No click-to-copy —
 * the "Share diagnostic" button at the bottom exports the full report at
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
  return {
    update: (next) => {
      valueEl.textContent = next;
    },
  };
}

function renderChainRadio(
  parent: HTMLElement,
  value: ChainBackend,
  label: string,
  description: string,
  current: ChainBackend,
  onSelect: (next: ChainBackend) => void,
): void {
  const row = buildRadioRow(`dotli-chain-${value}`, "dotli-chain-backend", {
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

function renderContentRadio(
  parent: HTMLElement,
  value: ContentBackend,
  label: string,
  description: string,
  current: ContentBackend,
  onSelect: (next: ContentBackend) => void,
): void {
  const row = buildRadioRow(`dotli-content-${value}`, "dotli-content-backend", {
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
  },
): HTMLLabelElement {
  const row = document.createElement("label");
  row.className = `mode-radio-row${opts.selected ? " selected" : ""}`;

  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = name;
  radio.value = opts.value;
  radio.checked = opts.selected;
  radio.className = "mode-radio-input";
  row.appendChild(radio);

  const dot = document.createElement("span");
  dot.className = "mode-radio-dot";
  row.appendChild(dot);

  const text = document.createElement("span");
  text.className = "mode-radio-text";
  text.innerHTML = `<span class="mode-radio-label">${opts.label}</span><span class="mode-radio-desc">${opts.description}</span>`;
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

  // The toggle owns its own on/off state locally — the `renderModePopover`
  // caller doesn't re-render the cache section on change (only chain/content
  // groups re-render), so the button has to flip its own class + aria
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

// ── Modal ─────────────────────────────────────────────────

function openModal(reason?: string, label?: string): void {
  modalQr.innerHTML = `<div class="spinner"></div>`;
  // A bare "localhost:<port>" label means dotli is in localhost-proxy
  // mode rendering a local dev server directly (apps/host/src/main.ts
  // localhost-proxy branch) — show it as-is. Deployed dotNs products
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

function closeModal(opts: { skipTruapiCancel?: boolean } = {}): void {
  modalBackdrop.classList.remove("open");

  if (opts.skipTruapiCancel !== true) {
    activeTruapiPairingCancel?.();
    activeTruapiPairingCancel = null;
  }
}
