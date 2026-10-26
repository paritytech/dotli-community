// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar folds away only once the URL pill's shield has settled, so the visitor sees how the page was checked.

export type ShieldAutoHideDeps = {
  loggedIn: { get: () => boolean; subscribe: (listener: () => void) => () => void };
  /** Lets the topbar fold away. */
  arm: () => void;
};

export type ShieldAutoHide = {
  /** The shield has settled, so the bar may fold from now on. */
  settle: () => void;
};

/** A login after the shield settled folds the bar. Signed out it folds all the same, with sign-in one reveal away. */
export function startShieldAutoHide(deps: ShieldAutoHideDeps): ShieldAutoHide {
  let settled = false;
  deps.loggedIn.subscribe(() => {
    if (deps.loggedIn.get() && settled) {
      deps.arm();
    }
  });
  return {
    settle: () => {
      settled = true;
      deps.arm();
    },
  };
}
