// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { catchError, createMemoryStorage } from '@dotli/shared/testing';
import { isDebugModeOn, leaveDebugMode, resolveDebugMode, type DebugModePage } from './debugMode.js';

type FakePage = {
  sessionStorage: Storage;
  replaceState: ReturnType<typeof vi.fn<(data: unknown, unused: string, url: string) => void>>;
} & DebugModePage;

/** A page at `href` whose tab storage holds `entries`. */
function createPage(href: string, entries: Record<string, string> = {}): FakePage {
  const stored = createMemoryStorage({ entries });
  const replaceState = vi.fn<(data: unknown, unused: string, url: string) => void>();
  return {
    replaceState,
    location: { href },
    history: { replaceState },
    sessionStorage: stored,
  };
}

/** A page whose tab storage throws, as in Safari private mode. */
function createPageWithoutStorage(href: string): DebugModePage & { replaceState: FakePage['replaceState'] } {
  function throwUnavailable(): never {
    throw new Error('SecurityError');
  }
  const replaceState = vi.fn<(data: unknown, unused: string, url: string) => void>();
  return {
    replaceState,
    location: { href },
    history: { replaceState },
    sessionStorage: { getItem: throwUnavailable, setItem: throwUnavailable },
  };
}

describe('debug mode', () => {
  it('As a dotli developer, I open a page with ?debug=true and the panel starts expanded, remembered for the tab and gone from the URL', () => {
    // Given
    const tab = createPage('https://app.dot.li/path?x=1&debug=true#top');

    // When
    const mode = resolveDebugMode(tab, false);

    // Then
    expect(mode).toEqual({ enabled: true, explicit: true });
    expect(tab.sessionStorage.getItem('dotli:truapi-debug')).toBe('1');
    expect(tab.replaceState).toHaveBeenCalledWith(null, '', '/path?x=1#top');
  });

  it('As a dotli developer, I open a page with ?debug=off on a debug build and the panel stays off', () => {
    // Given
    const tab = createPage('https://app.dot.li/?debug=off');

    // When
    const mode = resolveDebugMode(tab, true);

    // Then
    expect(mode).toEqual({ enabled: false, explicit: true });
    expect(tab.sessionStorage.getItem('dotli:truapi-debug')).toBe('0');
    expect(tab.replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('As a dotli developer who turned debug mode on earlier in this tab, I reload and it stays on', () => {
    // Given
    const tab = createPage('https://app.dot.li/', { 'dotli:truapi-debug': '1' });

    // When
    const mode = resolveDebugMode(tab, false);

    // Then
    expect(mode).toEqual({ enabled: true, explicit: true });
    expect(tab.replaceState).not.toHaveBeenCalled();
  });

  it('As a visitor who never chose, I get what the build decides and the panel starts collapsed', () => {
    // Given
    const tab = createPage('https://app.dot.li/?debug=maybe');

    // When
    const mode = resolveDebugMode(tab, true);

    // Then
    expect(mode).toEqual({ enabled: true, explicit: false });
    expect(tab.sessionStorage.length).toBe(0);
    expect(tab.replaceState).not.toHaveBeenCalled();
  });

  it('As a visitor in Safari private mode, I get what the build decides', () => {
    // Given
    const tab = createPageWithoutStorage('https://app.dot.li/?debug=true');

    // When
    const mode = resolveDebugMode(tab, false);

    // Then
    expect(mode).toEqual({ enabled: false, explicit: false });
  });

  it('As a visitor whose storage throws, I open a page with ?debug=true and the param still leaves the URL', () => {
    // Given
    const tab = createPageWithoutStorage('https://app.dot.li/path?x=1&debug=true#top');

    // When
    resolveDebugMode(tab, false);

    // Then
    expect(tab.replaceState).toHaveBeenCalledWith(null, '', '/path?x=1#top');
  });

  it('As a dotli developer who turned debug mode on in this tab, I check it and it reads as on', () => {
    // Given
    const tab = createPage('https://app.dot.li/', { 'dotli:truapi-debug': '1' });

    // When
    const debugModeOn = isDebugModeOn(tab);

    // Then
    expect(debugModeOn).toBe(true);
  });

  it('As a dotli developer, I close the panel and debug mode is off for the tab', () => {
    // Given
    const tab = createPage('https://app.dot.li/', { 'dotli:truapi-debug': '1' });

    // When
    leaveDebugMode(tab);
    const debugModeOn = isDebugModeOn(tab);
    const resolved = resolveDebugMode(tab, true);

    // Then
    expect(debugModeOn).toBe(false);
    expect(resolved).toEqual({ enabled: false, explicit: true });
  });

  it('As a visitor in Safari private mode, I close the panel without an error and debug mode reads as off', () => {
    // Given
    const tab = createPageWithoutStorage('https://app.dot.li/');

    // When
    const thrown = catchError(() => {
      leaveDebugMode(tab);
    });
    const debugModeOn = isDebugModeOn(tab);

    // Then
    expect(thrown).toBeUndefined();
    expect(debugModeOn).toBe(false);
  });
});
