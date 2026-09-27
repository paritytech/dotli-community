// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Top bar UI
//
// Wires the topbar's imperative pieces: the mobile "more" flyout and the
// product chat. The auth button, the user popover, the QR pairing modal, the
// permissions popover, the network (chains) popover and the settings popover
// are shell islands (components/shell/); the auth ones are driven by
// auth-controller.ts, and the network one by the network store, both of
// which this starts.
// All plain DOM manipulation, no framework.
//
import { setBlockSource } from "./network-monitor";
import { createBlockSource } from "./block-source";
import { startNetworkStore } from "./state/network";
import { initChatPanel } from "./chat/panel";
import { emitPersistedSessionUiState } from "./host-callbacks/SessionStore";
import {
  createBlockingModalCoordinator,
  type BlockingModalCoordinator,
} from "./blocking-modal-queue";
import { initAuthController } from "./auth-controller";
import { recordChainsButtonVisible } from "./state/topbar";
import { initTheme } from "./theme-controller";

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
      // Don't stop propagation: let the document-level close-outside
      // handlers run so opening the burger also closes the settings and
      // permissions popovers (islands, closing through createPopover). The
      // one below won't touch the more popover itself because
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
