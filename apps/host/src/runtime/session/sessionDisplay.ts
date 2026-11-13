// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// When the saved copy or a core speaks for the page, and what the page then shows.

import type { CoreReport, DotliAuthState, Presence } from './types.js';

/** The rules of what the page's session state shows. */
export const sessionDisplay = {
  isCopyAllowedToShow,
  isSignInWaitingElsewhere,
  getWithdrawnState,
};

/**
 * Whether the saved copy may change what the page shows. A core takes seconds to connect with a session stored for it,
 * so while the page shows it signed out the copy may show one at once. A store that comes back may end `Unreachable`
 * with no news from the core, whose session read already ended. A pairing stays the core's, and the core's next report
 * decides from there. While a core's own report is open to it, the copy may also replace a sign-in it showed itself.
 */
function isCopyAllowedToShow(coreReport: CoreReport | null, shown: DotliAuthState): boolean {
  return coreReport === null || isOpenToCopy(shown.tag) || isOpenToCopy(coreReport.auth.tag);
}

/** Whether the flag says a sign-in made elsewhere waits for a page that shows `tag`. */
function isSignInWaitingElsewhere(flag: Presence, tag: DotliAuthState['tag']): boolean {
  return flag === 'present' && isShowingSignedOut(tag);
}

/**
 * The state a page shows once the copy withdraws its sign-in, the core's own report, with `Unreachable` shown as
 * `Disconnected` since the read that withdrew the sign-in has just answered.
 */
function getWithdrawnState({ auth }: CoreReport): DotliAuthState {
  if (auth.tag === 'Unreachable') {
    return { tag: 'Disconnected' };
  }
  return auth;
}

/** The states in which the page holds no sign-in of its own and its button offers one. */
function isShowingSignedOut(tag: DotliAuthState['tag']): boolean {
  switch (tag) {
    case 'Disconnected':
    case 'Pairing':
    case 'Authenticating':
    case 'LoginFailed':
      return true;
    case 'Restoring':
    case 'Unreachable':
    case 'Connected':
      return false;
  }
}

/** The states the saved copy may replace while a core speaks for the page: signed out, failed or unreachable. */
function isOpenToCopy(tag: DotliAuthState['tag']): boolean {
  switch (tag) {
    case 'Disconnected':
    case 'LoginFailed':
    case 'Unreachable':
      return true;
    case 'Restoring':
    case 'Pairing':
    case 'Authenticating':
    case 'Connected':
      return false;
  }
}
