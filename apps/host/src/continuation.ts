// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Why the app is reloading this tab, written before the reload and read by the next boot for telemetry.

import { pageSessionStorage, type SafeStorage } from '@dotli/shared';

export type Continuation = 'reload_button' | 'switch_backend' | 'settings_change' | 'app_update';

const KEY = 'dotli:continuation';

const CONTINUATIONS: readonly string[] = [
  'reload_button',
  'switch_backend',
  'settings_change',
  'app_update',
] satisfies readonly Continuation[];

/** Where the reason is kept, the tab's sessionStorage unless given. */
export type ContinuationStore = Pick<SafeStorage, 'getItem' | 'setItem' | 'removeItem'>;

const tabSession: ContinuationStore = pageSessionStorage;

function isContinuation(value: string | null): value is Continuation {
  return value !== null && CONTINUATIONS.includes(value);
}

/** Call right before reloading. */
export function markContinuation(reason: Continuation, store: ContinuationStore = tabSession): void {
  store.setItem(KEY, reason);
}

export function peekContinuation(store: ContinuationStore = tabSession): Continuation | null {
  const value = store.getItem(KEY);
  return isContinuation(value) ? value : null;
}

/** Clears the reason, so it describes exactly one page load. */
export function takeContinuation(store: ContinuationStore = tabSession): Continuation | null {
  const value = peekContinuation(store);
  store.removeItem(KEY);
  return value;
}
