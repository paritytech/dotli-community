// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The tab's debug mode choice, the only reader and writer of its storage key. Must not import `@dotli/ui` or
// `solid-js`, since the host's entry and the eager settings actions read it.

const DEBUG_MODE_KEY = 'dotli:truapi-debug';

export interface DebugMode {
  enabled: boolean;
  /** Chosen in this tab rather than by the build, so the panel starts expanded. */
  explicit: boolean;
}

/** Where the choice lives. `window` is one. */
export interface DebugModePage {
  readonly location: { readonly href: string };
  readonly history: { replaceState(data: unknown, unused: string, url: string): void };
  readonly sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
}

/**
 * `?debug=true|off` wins and persists, stripped from the URL so the sandbox's strict validator never sees it. Then the
 * stored choice, then `buildDefault`.
 */
export function resolveDebugMode(page: DebugModePage, buildDefault: boolean): DebugMode {
  try {
    const url = new URL(page.location.href);
    const param = url.searchParams.get('debug');
    if (param === 'true' || param === 'off') {
      page.sessionStorage.setItem(DEBUG_MODE_KEY, param === 'off' ? '0' : '1');
      url.searchParams.delete('debug');
      const search = url.searchParams.toString();
      page.history.replaceState(null, '', url.pathname + (search === '' ? '' : `?${search}`) + url.hash);
    }
    const stored = page.sessionStorage.getItem(DEBUG_MODE_KEY);
    if (stored === '1' || stored === '0') {
      return { enabled: stored === '1', explicit: true };
    }
    // eslint-disable-next-line no-restricted-syntax -- URL or sessionStorage may be unavailable, as in Safari private mode, so fall through to the build's default.
  } catch {
    /* ignore */
  }
  return { enabled: buildDefault, explicit: false };
}

/** Whether this tab turned debug mode on, which hides the Settings button that turns it on. */
export function isDebugModeOn(page: Pick<DebugModePage, 'sessionStorage'>): boolean {
  try {
    return page.sessionStorage.getItem(DEBUG_MODE_KEY) === '1';
  } catch {
    // sessionStorage unavailable, as in Safari private mode.
    return false;
  }
}

/** Turns debug mode off for the tab. The caller reloads, which is how the panel goes away. */
export function leaveDebugMode(page: Pick<DebugModePage, 'sessionStorage'>): void {
  try {
    page.sessionStorage.setItem(DEBUG_MODE_KEY, '0');
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable, and the reload still closes the panel for this load.
  } catch {
    /* ignore */
  }
}
