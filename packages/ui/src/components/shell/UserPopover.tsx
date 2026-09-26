// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { requestTruapiDisconnect } from "../../auth-controller";
import { sessionUsername, shortenAccount, useAccount } from "./account";
import { createPopover } from "./popover";

let toggle: (() => void) | null = null;

/**
 * Open or close the user popover, as the auth button does when logged in.
 * Does nothing while the popover island is not mounted.
 */
export function toggleUserPopover(): void {
  toggle?.();
}

/**
 * The logged-in account's popover (`#user-popover`), a shell island (see
 * islands.tsx), swapped in for Shell.tsx's static markup after boot. It
 * shows the username (or the shortened account, with a hint that the
 * account has no username on this network) and Log out, which asks the
 * Rust core to disconnect.
 *
 * The auth button (the AuthButton island) opens and closes it through
 * toggleUserPopover(). A click outside, Escape and a blocking modal close
 * it; while open it holds the focus, as the permissions popover does
 * (createPopover's trapFocus), and gives it back to the auth button.
 */
export function UserPopover(): JSX.Element {
  let popover: HTMLDivElement | undefined;
  const account = useAccount();
  const username = (): string | undefined => {
    const session = account.session();
    return session === undefined ? undefined : sessionUsername(session);
  };
  const name = (): string => {
    const session = account.session();
    if (session === undefined) {
      return "";
    }
    return (
      sessionUsername(session) ??
      shortenAccount(session.identityAccountId ?? session.publicKey) ??
      "Connected with Polkadot Mobile"
    );
  };

  const menu = createPopover({
    // Looked up by id: the button is another island, which the landing page
    // may have moved.
    trigger: () => document.getElementById("auth-button") ?? undefined,
    surface: () => popover,
    trapFocus: true,
  });
  toggle = menu.toggle;
  onCleanup(() => {
    if (toggle === menu.toggle) {
      toggle = null;
    }
  });

  const onDisconnect = (): void => {
    menu.setOpen(false);
    requestTruapiDisconnect();
  };

  return (
    <div
      ref={(el) => {
        popover = el;
      }}
      class={["user-popover", { open: menu.open() }]}
      id="user-popover"
      tabindex="-1"
    >
      <div class="user-popover-name">
        <div class="label">Welcome back</div>
        <div class="name" id="user-popover-username">
          {name()}
        </div>
        {/* Explains the username-less state instead of leaving a bare
            address that reads as a rendering bug. */}
        <Show when={account.loggedIn() && (username() ?? "").length === 0}>
          <div id="user-popover-hint" class="user-popover-hint">
            No username found for this account on this network.
          </div>
        </Show>
      </div>
      <div class="user-popover-divider" />
      <button
        ref={(el) => {
          el.addEventListener("click", onDisconnect);
        }}
        class="user-popover-disconnect"
        id="user-popover-disconnect"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
        Log out
      </button>
    </div>
  );
}
