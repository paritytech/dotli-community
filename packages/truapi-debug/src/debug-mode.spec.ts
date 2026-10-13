// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '@dotli/shared/testing';
import { isDebugModeOn, leaveDebugMode, resolveDebugMode, type DebugModePage } from './debug-mode.js';

interface FakePage extends DebugModePage {
  sessionStorage: Storage;
  replaceState: ReturnType<typeof vi.fn<(data: unknown, unused: string, url: string) => void>>;
}

/** A page at `href` whose tab storage holds `entries`. */
function page(href: string, entries: Record<string, string> = {}): FakePage {
  const stored = memoryStorage(entries);
  const replaceState = vi.fn<(data: unknown, unused: string, url: string) => void>();
  return {
    replaceState,
    location: { href },
    history: { replaceState },
    sessionStorage: stored,
  };
}

/** A page whose tab storage throws, as in Safari private mode. */
function pageWithoutStorage(href: string): DebugModePage {
  const unavailable = (): never => {
    throw new Error('SecurityError');
  };
  return {
    location: { href },
    history: { replaceState: vi.fn() },
    sessionStorage: { getItem: unavailable, setItem: unavailable },
  };
}

describe('debug mode', () => {
  it('As a dotli developer, I open a page with ?debug=true and the panel starts expanded, remembered for the tab and gone from the URL', () => {
    // Given
    const tab = page('https://app.dot.li/path?x=1&debug=true#top');

    // When
    const mode = resolveDebugMode(tab, false);

    // Then
    expect(mode).toEqual({ enabled: true, explicit: true });
    expect(tab.sessionStorage.getItem('dotli:truapi-debug')).toBe('1');
    expect(tab.replaceState).toHaveBeenCalledWith(null, '', '/path?x=1#top');
  });

  it('As a dotli developer, I open a page with ?debug=off on a debug build and the panel stays off', () => {
    // Given
    const tab = page('https://app.dot.li/?debug=off');

    // When
    const mode = resolveDebugMode(tab, true);

    // Then
    expect(mode).toEqual({ enabled: false, explicit: true });
    expect(tab.sessionStorage.getItem('dotli:truapi-debug')).toBe('0');
    expect(tab.replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('As a dotli developer who turned debug mode on earlier in this tab, I reload and it stays on', () => {
    // Given
    const tab = page('https://app.dot.li/', { 'dotli:truapi-debug': '1' });

    // When
    const mode = resolveDebugMode(tab, false);

    // Then
    expect(mode).toEqual({ enabled: true, explicit: true });
    expect(tab.replaceState).not.toHaveBeenCalled();
  });

  it('As a visitor who never chose, I get what the build decides and the panel starts collapsed', () => {
    // Given
    const tab = page('https://app.dot.li/?debug=maybe');

    // When
    const mode = resolveDebugMode(tab, true);

    // Then
    expect(mode).toEqual({ enabled: true, explicit: false });
    expect(tab.sessionStorage.length).toBe(0);
    expect(tab.replaceState).not.toHaveBeenCalled();
  });

  it('As a visitor in Safari private mode, I get what the build decides', () => {
    // Given
    const tab = pageWithoutStorage('https://app.dot.li/?debug=true');

    // When
    const mode = resolveDebugMode(tab, false);

    // Then
    expect(mode).toEqual({ enabled: false, explicit: false });
  });

  it('As a dotli developer, I close the panel and debug mode is off for the tab', () => {
    // Given
    const tab = page('https://app.dot.li/', { 'dotli:truapi-debug': '1' });
    expect(isDebugModeOn(tab)).toBe(true);

    // When
    leaveDebugMode(tab);

    // Then
    expect(isDebugModeOn(tab)).toBe(false);
    expect(resolveDebugMode(tab, true)).toEqual({ enabled: false, explicit: true });
  });

  it('As a visitor in Safari private mode, debug mode reads as off and closing the panel still works', () => {
    // Given
    const tab = pageWithoutStorage('https://app.dot.li/');

    // When
    const leave = (): void => {
      leaveDebugMode(tab);
    };

    // Then
    expect(isDebugModeOn(tab)).toBe(false);
    expect(leave).not.toThrow();
  });
});
