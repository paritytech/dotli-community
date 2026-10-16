// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Why the app is reloading this tab, written before the reload and read by the next boot for telemetry.

export type Continuation = 'reload_button' | 'switch_backend' | 'settings_change' | 'app_update';

const KEY = 'dotli:continuation';

const CONTINUATIONS: readonly string[] = [
  'reload_button',
  'switch_backend',
  'settings_change',
  'app_update',
] satisfies readonly Continuation[];

function isContinuation(value: string | null): value is Continuation {
  return value !== null && CONTINUATIONS.includes(value);
}

/** Call right before reloading. */
export function markContinuation(reason: Continuation): void {
  try {
    sessionStorage.setItem(KEY, reason);
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode. The next load then reads as a plain browser reload, which is the honest fallback.
  } catch {
    /* sessionStorage unavailable */
  }
}

export function peekContinuation(): Continuation | null {
  try {
    const value = sessionStorage.getItem(KEY);
    return isContinuation(value) ? value : null;
  } catch {
    // sessionStorage may be unavailable in Safari private mode, where nothing was ever marked.
    return null;
  }
}

/** Clears the reason, so it describes exactly one page load. */
export function takeContinuation(): Continuation | null {
  const value = peekContinuation();
  try {
    sessionStorage.removeItem(KEY);
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode, where nothing was ever marked.
  } catch {
    /* sessionStorage unavailable */
  }
  return value;
}
