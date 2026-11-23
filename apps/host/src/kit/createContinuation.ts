// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Why the app is reloading this tab, written before the reload and read by the next boot for telemetry. Also the
// tab's one reload per build for an update.

import { pageSessionStorage, realTimers, type SafeStorage, type Timers } from '@dotli/shared';

export type Continuation = 'reload_button' | 'switch_backend' | 'settings_change' | 'app_update';

type Params = {
  /** Where the reason is kept. Its reads and writes never throw. */
  store: Pick<SafeStorage, 'getItem' | 'setItem' | 'removeItem'>;
  /** The build that claims a reload for an update. This page's build by default, one fixed id without a commit. */
  build?: string;
};

type ReloadForUpdateParams = {
  /** The timers the wait runs on. The page's own by default. */
  timers?: Pick<Timers, 'setTimeout'>;
  /** Records the reason and reloads the page. The page's own reload by default. */
  reload?: (reason: Continuation) => void;
};

const KEY = 'dotli:continuation';

const UPDATE_RELOAD_KEY = 'dotli:update-reload';

/** Long enough for the user to read the screen that says the page reloads for an update. */
const UPDATE_RELOAD_DELAY_MS = 1_000;

const CONTINUATIONS: readonly string[] = [
  'reload_button',
  'switch_backend',
  'settings_change',
  'app_update',
] satisfies readonly Continuation[];

/** Builds the reload reason and the update's reload claim over `store`. */
export function createContinuation({ store, build = import.meta.env.VITE_COMMIT_SHA ?? 'dev' }: Params) {
  function mark(reason: Continuation): void {
    store.setItem(KEY, reason);
  }

  function peek(): Continuation | null {
    const value = store.getItem(KEY);
    return isContinuation(value) ? value : null;
  }

  function take(): Continuation | null {
    const value = peek();
    store.removeItem(KEY);
    return value;
  }

  function claimUpdateReload(): boolean {
    if (store.getItem(UPDATE_RELOAD_KEY) === build) {
      return false;
    }
    store.setItem(UPDATE_RELOAD_KEY, build);
    // A storage that drops the write gives no claim, so a tab that cannot remember it never reloads in a loop.
    return store.getItem(UPDATE_RELOAD_KEY) === build;
  }

  return {
    /** Records why the app reloads, right before the reload. Never throws. */
    mark,
    /**
     * Returns the reason the last reload recorded, leaving it in place, or null for none this build knows. Never
     * throws.
     */
    peek,
    /**
     * Returns the reason the last reload recorded, or null for none this build knows, and clears it, so it describes
     * exactly one page load. Never throws.
     */
    take,
    /**
     * Claims this build's one reload of the tab for an update. True when this build had not claimed it in this tab yet
     * and the claim is stored, so the tab may reload.
     */
    claimUpdateReload,
  };
}

/** The page's reload reason, kept in the tab's session storage. */
export const continuation = createContinuation({ store: pageSessionStorage });

/** Records `reason` on the page's reload reason, then reloads the page. Throws only as the page's reload does. */
export function markAndReload(reason: Continuation): void {
  continuation.mark(reason);
  window.location.reload();
}

/** Reloads the page for an update about a second from now, so the user first reads the screen that says so. */
export function reloadForUpdate({ timers = realTimers, reload = markAndReload }: ReloadForUpdateParams = {}): void {
  timers.setTimeout(() => {
    reload('app_update');
  }, UPDATE_RELOAD_DELAY_MS);
}

function isContinuation(value: string | null): value is Continuation {
  return value !== null && CONTINUATIONS.includes(value);
}
