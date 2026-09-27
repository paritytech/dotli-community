// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Top bar UI
//
// Wires the topbar's imperative pieces: the mode (settings) popover, the
// mobile "more" flyout, and the product chat. The auth button, the user
// popover, the QR pairing modal, the permissions popover and the network
// (chains) popover are shell islands (components/shell/); the auth ones are
// driven by auth-controller.ts, and the network one by the network store,
// both of which this starts.
// All plain DOM manipulation, no framework.
//
import { setBlockSource } from "./network-monitor";
import { createBlockSource } from "./block-source";
import { startNetworkStore } from "./state/network";
import {
  formatAppVersion,
  getActiveAppManifest,
  getActiveRootManifest,
} from "@dotli/shared/active-manifest";
import {
  createRemoteChainProvider,
  isRemoteChainSupported,
} from "@dotli/protocol/client";
import {
  getCacheSettings,
  setCacheSettings,
  getBackend,
  setBackend,
  isSharedWorkerAvailable,
  isVerifiedSession,
  BACKEND_LABELS,
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
import { ALL_PERMISSIONS, getPermissionStatuses } from "./permissions";
import { initChatPanel } from "./chat/panel";
import { emitPersistedSessionUiState } from "./host-callbacks/SessionStore";
import {
  createBlockingModalCoordinator,
  type BlockingModalCoordinator,
} from "./blocking-modal-queue";
import { initAuthController } from "./auth-controller";
import { getProductState } from "./state/product";
import { recordChainsButtonVisible } from "./state/topbar";
import { initTheme, THEME_KEY } from "./theme-controller";

function getElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`Element #${id} not found`);
  }
  return el;
}

// DOM refs are resolved lazily inside initTopBar() to avoid throwing
// at module scope if the HTML IDs change or the script loads early.
let modeButton: HTMLElement;
let modePopover: HTMLElement;
let modePopoverContent: HTMLElement;
let modePopoverBackdrop: HTMLElement | null = null;

export function initTopBar(
  modalCoordinator: BlockingModalCoordinator = createBlockingModalCoordinator(),
): void {
  // The login and auth-state listeners, from boot on: the auth islands
  // mount later and render what the controller has kept.
  initAuthController(modalCoordinator);

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
      modePopover.classList.contains("open") &&
      !modePopover.contains(e.target as Node) &&
      !modeButton.contains(e.target as Node)
    ) {
      setModePopoverOpen(false);
    }
  });

  // Set logo home link from VITE_APP_URL (defaults to /)
  const homeLink = document.getElementById(
    "topbar-home",
  ) as HTMLAnchorElement | null;
  if (homeLink !== null) {
    homeLink.href = (import.meta.env.VITE_APP_URL as string | undefined) ?? "/";
  }

  // Theme preference (the toggle itself is components/shell/ThemeToggle.tsx)
  initTheme();

  // Mode toggle (P2P / Centralized)
  initModeToggle();
  // The chains the network popover (an island) watches, and the store it
  // renders, from boot on.
  setBlockSource(createBlockSource());
  startNetworkStore();

  // Product chat button + docked panel
  initChatPanel();

  window.addEventListener("dotli:blocking-modal-active", (event: Event) => {
    const { active } = (event as CustomEvent<{ active: boolean }>).detail;
    if (!active) {
      return;
    }
    setModePopoverOpen(false);
    morePopover?.classList.remove("open");
    moreButton?.setAttribute("aria-expanded", "false");
  });

  // Rehydrate the persisted same-origin session on idle so a reload shows
  // the logged-in badge before any core instance boots.
  scheduleIdle(() => {
    emitPersistedSessionUiState();
  });
}

function scheduleIdle(callback: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => {
      callback();
    });
  } else {
    window.setTimeout(callback, 0);
  }
}

/**
 * Reveal the network button. The host calls this once a product is on
 * screen, so the icon appears with the app rather than during the load.
 * Writes the store the chains island renders, and the static button's class
 * for the time before the island is swapped in (after the swap the element
 * is the island's, which renders the same class from the store).
 */
export function setChainsButtonVisible(visible: boolean): void {
  recordChainsButtonVisible(visible);
  document
    .getElementById("chains-button")
    ?.classList.toggle("visible", visible);
}

function initModeToggle(): void {
  modeButton = getElement("mode-button");
  modePopover = getElement("mode-popover");
  modePopoverContent = getElement("mode-popover-content");
  // Backdrop is optional. Older host shells that haven't added the element
  // still work, the popover just doesn't get a modal overlay there.
  modePopoverBackdrop = document.getElementById("mode-popover-backdrop");

  modeButton.setAttribute("aria-haspopup", "dialog");
  modeButton.setAttribute("aria-expanded", "false");
  modeButton.setAttribute("aria-controls", modePopover.id);
  modePopover.setAttribute("role", "dialog");
  modePopover.setAttribute("aria-label", "Settings");
  modePopover.tabIndex = -1;

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

let modePopoverFocusTrap: (() => void) | null = null;

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Escape, Tab containment, and focus restore for an open popover: attach on
 * open, cleanup on close.
 */
function trapPopoverFocus(
  popover: HTMLElement,
  trigger: HTMLElement,
  close: () => void,
): () => void {
  const focusables = (): HTMLElement[] =>
    Array.from(popover.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter(
        // Match native tab order: unchecked radios are reached with arrow
        // keys inside their group, not with Tab.
        (el) =>
          !(
            el instanceof HTMLInputElement &&
            el.type === "radio" &&
            !el.checked
          ),
      )
      .filter(
        // Skip controls CSS hides, like the sheet close button on desktop.
        (el) =>
          typeof el.checkVisibility !== "function" || el.checkVisibility(),
      );

  function onKeyDown(ev: KeyboardEvent): void {
    // A popover removed from the document without a close call must not
    // keep acting on key events.
    if (!popover.isConnected) {
      return;
    }
    if (ev.key === "Escape") {
      close();
      return;
    }
    if (ev.key !== "Tab") {
      return;
    }
    const items = focusables();
    if (items.length === 0) {
      ev.preventDefault();
      popover.focus();
      return;
    }
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && popover.contains(active);
    if (ev.shiftKey) {
      if (!inside || active === items[0] || active === popover) {
        ev.preventDefault();
        items[items.length - 1].focus();
      }
    } else if (!inside || active === items[items.length - 1]) {
      ev.preventDefault();
      items[0].focus();
    }
  }

  document.addEventListener("keydown", onKeyDown);
  popover.focus();

  return () => {
    document.removeEventListener("keydown", onKeyDown);
    // Restore focus unless the user already moved it somewhere else,
    // e.g. by clicking outside the popover to dismiss it.
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      popover.contains(active)
    ) {
      trigger.focus();
      if (document.activeElement !== trigger) {
        document.getElementById("more-button")?.focus();
      }
    }
  };
}

/**
 * Single source of truth for popover open/close. Keeps the backdrop in
 * sync with the popover visibility so "the rest of the page is blocked
 * while settings are open" always holds.
 */
function setModePopoverOpen(open: boolean): void {
  modePopover.classList.toggle("open", open);
  modePopoverBackdrop?.classList.toggle("open", open);
  modeButton.setAttribute("aria-expanded", String(open));
  if (open) {
    renderModePopover();
    modePopoverFocusTrap ??= trapPopoverFocus(modePopover, modeButton, () => {
      setModePopoverOpen(false);
    });
  } else {
    modePopoverFocusTrap?.();
    modePopoverFocusTrap = null;
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
    networkGroup.setAttribute("role", "radiogroup");
    networkGroup.setAttribute("aria-label", "Network");
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
            // The rebuild replaced the focused input. Refocus the checked
            // radio so keyboard arrow navigation survives the re-render.
            networkGroup
              .querySelector<HTMLInputElement>("input:checked")
              ?.focus();
            syncApply();
          },
        );
      }
    };
    rerenderNetwork();
  }

  // Only separate from the Network section when there is one. With a single
  // enabled network this header leads the column and must line up with
  // Diagnostics opposite.
  appendSectionHeader(
    leftCol,
    "Network Transport",
    enabledNetworks.length > 1 ? "mode-popover-section--spaced" : undefined,
  );
  const chainChoices: [Backend, string, string][] = [
    [
      "smoldot-direct",
      BACKEND_LABELS["smoldot-direct"],
      "Verified in your browser, separate per tab (recommended)",
    ],
    [
      "smoldot-shared-worker",
      BACKEND_LABELS["smoldot-shared-worker"],
      "Verified in your browser, shared across tabs",
    ],
    [
      "rpc-gateway",
      BACKEND_LABELS["rpc-gateway"],
      "Fetched from trusted servers, fastest but less private",
    ],
  ];
  const chainGroup = document.createElement("div");
  chainGroup.setAttribute("role", "radiogroup");
  chainGroup.setAttribute("aria-label", "Network Transport");
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
          // The rebuild replaced the focused input. Refocus the checked
          // radio so keyboard arrow navigation survives the re-render.
          chainGroup.querySelector<HTMLInputElement>("input:checked")?.focus();
          syncApply();
        },
      );
    }
  };
  rerenderChain();

  appendSectionHeader(leftCol, "Cache", "mode-popover-section--bottom");
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
      await wipeOriginState();
      setBackend(draft.chain);
      setNetwork(draft.network);
      setCacheSettings(draft.cache);
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
 * Keys that describe the browser rather than the state a reset clears.
 *
 * The theme is what the visitor chose to look at, not state they asked the
 * reset to clear. Losing it turns a settings reset into a visible change
 * nobody requested.
 */
const PRESERVED_KEYS: readonly string[] = [THEME_KEY];

/**
 * Wipe this origin's IDB, CacheStorage, SW registrations, localStorage,
 * sessionStorage. Best-effort: Firefox and Safari pre-17 lack
 * `indexedDB.databases()`. Everything in `PRESERVED_KEYS` survives. Callers
 * still re-write settings they want to change, since those are new values
 * rather than preserved ones.
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
    const preserved = PRESERVED_KEYS.map(
      (key) => [key, localStorage.getItem(key)] as const,
    );
    localStorage.clear();
    for (const [key, value] of preserved) {
      if (value !== null) {
        localStorage.setItem(key, value);
      }
    }
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

function appendSectionHeader(
  parent: HTMLElement,
  text: string,
  modifier?: string,
): void {
  const header = document.createElement("div");
  header.className =
    modifier === undefined
      ? "mode-popover-section"
      : `mode-popover-section ${modifier}`;
  header.textContent = text;
  parent.appendChild(header);
}

// Baked at build time by `apps/host/vite.config.ts` (`define.*`). The
// topbar only ever renders in the host shell so these will always be
// present in practice. `undefined` fallbacks are defensive for tests and
// for any future caller that imports this module from a different bundle.
declare const __DOTLI_VERSION__: string | undefined;
declare const __LIGHT_CLIENT_VERSION__: string | undefined;
declare const __POLKADOT_API_VERSION__: string | undefined;
declare const __POLKADOT_API_VERSIONS__:
  { name: string; version: string }[] | undefined;
declare const __PARITY_TRUAPI_VERSIONS__:
  { name: string; version: string }[] | undefined;

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

  // Version only. The per-chain block heights live in the network popover,
  // where they can be read live.
  appendSectionHeader(parent, "Light client");
  renderInfoRow(
    parent,
    "@parity/truapi-provider",
    buildLightClientVersionLabel(),
  );

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

  const parityTruapi =
    typeof __PARITY_TRUAPI_VERSIONS__ === "undefined"
      ? []
      : __PARITY_TRUAPI_VERSIONS__;

  if (polkadotApi.length > 0) {
    appendSectionHeader(parent, "@polkadot-api");
    for (const pkg of polkadotApi) {
      renderInfoRow(parent, pkg.name, pkg.version);
    }
  }
  if (parityTruapi.length > 0) {
    appendSectionHeader(parent, "@parity/truapi");
    for (const pkg of parityTruapi) {
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
    void (async () => {
      // Block heights now live in the Network popover, so nothing has them
      // cached. Query them here, where a report is actually being made,
      // instead of keeping four chains awake for a panel nobody opened.
      const smoldotInfo = await collectSmoldotInfo();
      const report = await formatDiagnosticsReport(
        base,
        smoldotInfo,
        polkadotApi,
        parityTruapi,
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
    })();
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
 *    4. Packages: flat list of smoldot, polkadot-api, and @parity/truapi,
 *                 with the block heights queried at share time. They are
 *                 not rendered in this popover any more, they live in the
 *                 network panel where they can be read live. */
async function formatDiagnosticsReport(
  base: [label: string, value: string][],
  smoldot: SmoldotInfo,
  polkadotApi: { name: string; version: string }[],
  parityTruapi: { name: string; version: string }[],
): Promise<string> {
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
  const product = getProductState();
  if (product.status === "loaded") {
    const productLabel = product.label;
    lines.push("", "Permissions:");
    const statuses = await getPermissionStatuses(
      productLabel,
      ALL_PERMISSIONS.map(({ name }) => name),
    );
    for (const [index, perm] of ALL_PERMISSIONS.entries()) {
      const status = statuses[index] ?? "ask";
      lines.push(`  ${perm.label}: ${status === "granted" ? "on" : "off"}`);
    }
  }

  // Packages, one flat list. smoldot leads because it's the heaviest
  // dependency and the one most issues are ultimately about.
  lines.push("", "Packages:", `  smoldot: ${smoldot.version}`);
  for (const p of polkadotApi) {
    lines.push(`  ${p.name}: ${p.version}`);
  }
  for (const p of parityTruapi) {
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
    ["Network Transport", backendLabel(backend)],
  ];

  // Sub-row attached to the Network Transport row:
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
  return BACKEND_LABELS[b];
}

/** Gather the smoldot readouts a diagnostic report quotes. */
async function collectSmoldotInfo(): Promise<SmoldotInfo> {
  const info: SmoldotInfo = {
    version: buildLightClientVersionLabel(),
    blocks: { relay: "n/a", assetHub: "n/a", people: "n/a" },
  };
  if (getBackend() === "rpc-gateway") {
    return info;
  }
  const cfg = getActiveServicesConfig();
  const [relay, assetHub, people] = await Promise.all([
    queryFinalizedBlock(cfg.relay.genesis),
    queryFinalizedBlock(cfg.assethub.genesis),
    queryFinalizedBlock(cfg.people.genesis),
  ]);
  info.blocks = {
    relay: formatBlock(relay),
    assetHub: formatBlock(assetHub),
    people: formatBlock(people),
  };
  return info;
}

interface SmoldotInfo {
  /** Human-facing version label, e.g. "3.0.0 (c33c647)". */
  version: string;
  /** Mutable block readouts for the share report. */
  blocks: { relay: string; assetHub: string; people: string };
}

// The light client is smoldot compiled into truapi-provider's wasm, so the
// provider version is what identifies the build. There is no separate smoldot
// version to report.
function buildLightClientVersionLabel(): string {
  return typeof __LIGHT_CLIENT_VERSION__ === "string"
    ? __LIGHT_CLIENT_VERSION__
    : "unknown";
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
  toggle.setAttribute("aria-label", label);

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
