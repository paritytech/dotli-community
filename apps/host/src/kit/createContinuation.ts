// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Why the app is reloading this tab, written before the reload and read by the next boot for telemetry.

import { pageSessionStorage, type SafeStorage } from '@dotli/shared';

export type Continuation = 'reload_button' | 'switch_backend' | 'settings_change' | 'app_update';

type Params = {
  /** Where the reason is kept. Its reads and writes never throw. */
  store: Pick<SafeStorage, 'getItem' | 'setItem' | 'removeItem'>;
};

const KEY = 'dotli:continuation';

const CONTINUATIONS: readonly string[] = [
  'reload_button',
  'switch_backend',
  'settings_change',
  'app_update',
] satisfies readonly Continuation[];

/** Builds the reload reason over `store`. */
export function createContinuation({ store }: Params) {
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
  };
}

/** The page's reload reason, kept in the tab's session storage. */
export const continuation = createContinuation({ store: pageSessionStorage });

/** Records `reason` on the page's reload reason, then reloads the page. Throws only as the page's reload does. */
export function markAndReload(reason: Continuation): void {
  continuation.mark(reason);
  window.location.reload();
}

function isContinuation(value: string | null): value is Continuation {
  return value !== null && CONTINUATIONS.includes(value);
}
