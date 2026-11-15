// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The tab's debug mode choice, the only reader and writer of its URL param and its storage key.

import { createReporter, defineCount } from '@dotli/metrics';

const report = createReporter({ flow: 'ui' });

/**
 * A tab storage access for the debug mode choice that threw, as where the browser blocks storage. Tagged `outcome`
 * (error) and `reason` (the error's name), as the choice then reads as unset or holds for this load alone.
 */
const debugModeStorageMetric = defineCount<'error'>('debug_mode.storage');

/**
 * A history update that refused to strip the `debug` param, so the param stays in the URL. Tagged `outcome` (error)
 * and `reason` (the error's name).
 */
const debugParamStripMetric = defineCount<'error'>('debug_mode.param_strip');

const DEBUG_MODE_KEY = 'dotli:truapi-debug';
const DEBUG_PARAM = 'debug';

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
  /** The tab's storage, which holds the choice. Any access may throw, as where the browser blocks storage. */
  readonly sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
};

/**
 * `?debug=true|off` wins, stripped from the URL so a reload after leaving debug mode, or a copied link, does not apply
 * it again. It persists where tab storage works and wins for this load alone where storage throws. Then the stored
 * choice, then `buildDefault`.
 */
export function resolveDebugMode(page: DebugModePage, buildDefault: boolean): DebugMode {
  const fromParam = takeDebugParam(page);
  if (fromParam !== null) {
    storeChoice(page, fromParam);
    return { enabled: fromParam, explicit: true };
  }
  const stored = readChoice(page);
  if (stored === null) {
    return { enabled: buildDefault, explicit: false };
  }
  return { enabled: stored, explicit: true };
}

/** `href` with debug mode requested, for a navigation that opens the page with the panel on. */
export function getDebugModeUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.set(DEBUG_PARAM, 'true');
  return url.toString();
}

/** Whether this tab chose debug mode on, leaving the build's default aside. */
export function isDebugModeOn(page: Pick<DebugModePage, 'sessionStorage'>): boolean {
  return readChoice(page) === true;
}

/** Turns debug mode off for the tab. The caller reloads, which is how the panel goes away. */
export function leaveDebugMode(page: Pick<DebugModePage, 'sessionStorage'>): void {
  storeChoice(page, false);
}

/** The `debug` param's choice, stripped from the URL, or null when the URL carries none. */
function takeDebugParam(page: DebugModePage): boolean | null {
  const url = new URL(page.location.href);
  const param = url.searchParams.get(DEBUG_PARAM);
  if (param !== 'true' && param !== 'off') {
    return null;
  }
  url.searchParams.delete(DEBUG_PARAM);
  try {
    page.history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch (error) {
    report.expected(error, { step: 'debug_param_strip', metric: debugParamStripMetric });
  }
  return param === 'true';
}

/** The tab's stored choice, or null when it holds none or its storage throws. */
function readChoice(page: Pick<DebugModePage, 'sessionStorage'>): boolean | null {
  try {
    const stored = page.sessionStorage.getItem(DEBUG_MODE_KEY);
    return stored === '1' || stored === '0' ? stored === '1' : null;
  } catch (error) {
    report.expected(error, { step: 'debug_mode_read', metric: debugModeStorageMetric });
    return null;
  }
}

function storeChoice(page: Pick<DebugModePage, 'sessionStorage'>, enabled: boolean): void {
  try {
    page.sessionStorage.setItem(DEBUG_MODE_KEY, enabled ? '1' : '0');
  } catch (error) {
    report.expected(error, { step: 'debug_mode_write', metric: debugModeStorageMetric });
  }
}
