// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar folds away only once the URL pill's shield has settled, so the visitor sees how the page was checked.

type Params = {
  /** Whether the visitor is signed in. Its `listen` returns the unlisten. */
  loggedIn: { get: () => boolean; listen: (listener: () => void) => () => void };
  /** Lets the topbar fold away. */
  arm: () => void;
};

/**
 * Starts folding the bar on the shield's settle. A login after the shield settled folds the bar. Signed out it folds
 * all the same, with sign-in one reveal away. Throws only as `loggedIn.listen` does.
 */
export function startShieldAutoHide({ loggedIn, arm }: Params) {
  let settled = false;
  const dispose = loggedIn.listen(() => {
    if (loggedIn.get() && settled) {
      arm();
    }
  });
  function settle(): void {
    settled = true;
    arm();
  }

  return {
    /** Records that the shield has settled, so the bar may fold from now on. Throws only as `arm` does. */
    settle,
    /** Stops hearing logins, so a later one folds nothing. Throws only as the unlisten `loggedIn` returned does. */
    dispose,
  };
}
