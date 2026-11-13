// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The tab's debug mode choice, the only reader and writer of its storage key. Must not import `@dotli/ui` or
// `solid-js`, since the host's entry and the eager settings actions read it.

const DEBUG_MODE_KEY = 'dotli:truapi-debug';

export type DebugMode = {
  /** Whether the debug panel loads on this page. */
  enabled: boolean;
  /** Chosen in this tab rather than by the build, so the panel starts expanded. */
  explicit: boolean;
};

/** Where the choice lives. `window` is one. */
export type DebugModePage = {
  /** The page URL, read for the `debug` param. */
  readonly location: { readonly href: string };
  /** Replaces the current URL without a navigation. `replaceState` may throw. */
  readonly history: { replaceState(data: unknown, unused: string, url: string): void };
  /** The tab's storage, which holds the choice. Any access may throw, as in Safari private mode. */
  readonly sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
};

/**
 * `?debug=true|off` wins, stripped from the URL so the sandbox's strict validator never sees it. It persists where
 * tab storage works and wins for this load alone where storage throws. Then the stored choice, then `buildDefault`.
 */
export function resolveDebugMode(page: DebugModePage, buildDefault: boolean): DebugMode {
  let param: string | null = null;
  try {
    const url = new URL(page.location.href);
    param = url.searchParams.get('debug');
    if (param === 'true' || param === 'off') {
      url.searchParams.delete('debug');
      const search = url.searchParams.toString();
      page.history.replaceState(null, '', url.pathname + (search === '' ? '' : `?${search}`) + url.hash);
    }
    // eslint-disable-next-line no-restricted-syntax -- the URL or history may be unavailable, so fall through to the stored choice.
  } catch {
    /* ignore */
  }
  try {
    if (param === 'true' || param === 'off') {
      page.sessionStorage.setItem(DEBUG_MODE_KEY, param === 'off' ? '0' : '1');
    }
    const stored = page.sessionStorage.getItem(DEBUG_MODE_KEY);
    if (stored === '1' || stored === '0') {
      return { enabled: stored === '1', explicit: true };
    }
  } catch {
    // sessionStorage may be unavailable, as in Safari private mode, so the param wins for this load alone, and without
    // one the build's default applies.
    if (param === 'true' || param === 'off') {
      return { enabled: param === 'true', explicit: true };
    }
  }
  return { enabled: buildDefault, explicit: false };
}

/** Whether this tab turned debug mode on, which hides the Settings button that turns it on. */
export function isDebugModeOn(page: Pick<DebugModePage, 'sessionStorage'>): boolean {
  try {
    return page.sessionStorage.getItem(DEBUG_MODE_KEY) === '1';
  } catch {
    // sessionStorage may be unavailable, as in Safari private mode, so debug mode reads as off.
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
