// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { startLogin } from "../../auth-controller";
import { getAuthState } from "../../state/auth";
import { sessionInitials, useAccount } from "./account";
import { toggleUserPopover } from "./UserPopover";

function UserIcon(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

/**
 * The topbar's auth button (`#auth-button`), a shell island (see
 * islands.tsx). Shell.tsx prerenders it disabled and "Connecting...", and it
 * stays so until this component is swapped in, enabled, after boot (so it is
 * none of the islands loader's click triggers). The landing page
 * (components/landing/) moves the button into `#landing-auth`; the swap
 * happens where it is.
 *
 * Logged out, it shows the person icon and a click starts a login. Logged
 * in, it shows the account's initials (`.user-badge`, or the icon as
 * `.user-badge-anon` without a username) and a click toggles the user
 * popover (the UserPopover island). It renders the auth stores, whatever
 * they held when it mounted.
 */
export function AuthButton(): JSX.Element {
  const account = useAccount();
  const label = (): string =>
    account.loggedIn() ? "Account" : "Login with Polkadot Mobile";

  const onClick = (): void => {
    if (getAuthState().tag === "Connected") {
      toggleUserPopover();
    } else {
      startLogin();
    }
  };

  return (
    <button
      ref={(el) => {
        el.addEventListener("click", onClick);
      }}
      id="auth-button"
      class="topbar-btn"
      title={label()}
      aria-label={label()}
    >
      <Show
        when={account.loggedIn() && account.session()}
        fallback={<UserIcon />}
      >
        {(session) => (
          <Show
            when={sessionInitials(session())}
            fallback={
              <div class="user-badge user-badge-anon">
                <UserIcon />
              </div>
            }
          >
            {(initials) => <div class="user-badge">{initials()}</div>}
          </Show>
        )}
      </Show>
    </button>
  );
}
