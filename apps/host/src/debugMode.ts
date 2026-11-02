// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// This tab's debug mode: whether it is on, and the reloads into and out of it.

import { isDebugModeOn, leaveDebugMode } from '@dotli/truapi-debug';

/** Returns whether this tab runs in debug mode. Never throws. */
export function isTruapiDebugEnabled(): boolean {
  return isDebugModeOn(window);
}

/** Reloads this tab with the debug panel on. */
export function openInDebugMode(): void {
  const url = new URL(window.location.href);
  url.searchParams.set('debug', 'true');
  window.location.assign(url.toString());
}

/** Turns debug mode off for this tab and reloads it without the panel. */
export function closeDebugMode(): void {
  leaveDebugMode(window);
  window.location.reload();
}
