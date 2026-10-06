// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Why this tab is about to reload, when the app itself is the one reloading it.
//
// A reload looks the same to the next page whichever button caused it, so the
// code that reloads writes its reason here first and the next boot reads it
// back. Telemetry uses it to tell a visitor who retried from the error page
// from one who switched transport or applied new settings. Per tab, and never
// more than the one value: it describes the next page load and nothing else.

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

/** Record why the reload that follows is happening. Call right before reloading. */
export function markContinuation(reason: Continuation): void {
  try {
    sessionStorage.setItem(KEY, reason);
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode. The next load then reads as a plain browser reload, which is the honest fallback.
  } catch {
    /* sessionStorage unavailable */
  }
}

/** The reason the last page set before leaving, without consuming it. */
export function peekContinuation(): Continuation | null {
  try {
    const value = sessionStorage.getItem(KEY);
    return isContinuation(value) ? value : null;
  } catch {
    // sessionStorage may be unavailable in Safari private mode, where nothing was ever marked.
    return null;
  }
}

/** Read and clear the reason, so it describes exactly one page load. */
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
