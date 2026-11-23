// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The tab's one reload per build for a newer release: the claim, the screen that says so, the wait and the reload.

import { pageSessionStorage, realTimers, type Timers } from '@dotli/shared';
import { createStoredAtom, type PersistentAtomParams } from '@dotli/stores-persistent';
import { showError } from '@dotli/ui';
import { markAndReload, type Continuation } from './createContinuation.js';

type Params = {
  /** Where the claim is kept. Its reads and writes never throw. */
  store: PersistentAtomParams<string>['storage'];
  /** The build that claims the reload. This page's build by default, one fixed id without a commit. */
  build?: string;
  /** The timers the wait runs on. The page's own by default. */
  timers?: Pick<Timers, 'setTimeout'>;
  /** Shows the screen that says the page reloads for an update. The page's error screen by default. */
  show?: () => void;
  /** Records the reason and reloads the page. The page's own reload by default. */
  reload?: (reason: Continuation) => void;
};

const KEY = 'dotli:update-reload';

/** Long enough for the user to read the screen that says the page reloads for an update. */
const DELAY_MS = 1_000;

/** Builds the update reload over `store`. */
export function createUpdateReload({
  store,
  build = import.meta.env.VITE_COMMIT_SHA ?? 'dev',
  timers = realTimers,
  show = showUpdateLoading,
  reload = markAndReload,
}: Params) {
  const claim = createStoredAtom({
    key: KEY,
    storage: store,
    // No build has claimed the reload.
    initial: '',
    decode: raw => raw,
    encode: claimed => claimed,
  });

  function start(): boolean {
    if (claim.get() === build) {
      return false;
    }
    claim.set(build);
    // A storage that drops the write leaves the claim as it was, so a tab that cannot remember it never reloads in a loop.
    if (claim.get() !== build) {
      return false;
    }
    show();
    timers.setTimeout(() => {
      reload('app_update');
    }, DELAY_MS);
    return true;
  }

  return {
    /**
     * Claims this build's one reload of the tab and, when the claim holds, shows the screen that says so and reloads
     * the page about a second later. True when the claim holds. A build that already claimed it, or a tab that cannot
     * store the claim, gets false and nothing shown. Throws what showing the screen throws, before the reload is set.
     */
    start,
  };
}

export type UpdateReload = ReturnType<typeof createUpdateReload>;

/** The page's update reload, claimed in the tab's session storage. */
export const updateReload = createUpdateReload({ store: pageSessionStorage });

function showUpdateLoading(): void {
  // No buttons, since the page is already doing what a Reload button would.
  showError('Loading the new version of dot.li', { detail: 'dot.li was updated since this page loaded.' });
}
