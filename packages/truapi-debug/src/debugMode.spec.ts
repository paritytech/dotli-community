// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { recordReports } from '@dotli/metrics/testing';
import { catchError, createMemoryStorage } from '@dotli/shared/testing';
import { getDebugModeUrl, isDebugModeOn, leaveDebugMode, resolveDebugMode, type DebugModePage } from './debugMode.js';

/** Tab storage that throws on every access, as where the browser blocks storage. */
const BLOCKED_STORAGE: DebugModePage['sessionStorage'] = {
  getItem: throwBlocked,
  setItem: throwBlocked,
};

/** A page at `href` whose tab storage is `sessionStorage`, with a spy on its history updates. */
function createPage(href: string, sessionStorage: DebugModePage['sessionStorage'] = createMemoryStorage()) {
  const replaceState = vi.fn<DebugModePage['history']['replaceState']>();
  return { replaceState, location: { href }, history: { replaceState }, sessionStorage };
}

function throwBlocked(): never {
  throw new Error('SecurityError');
}

describe('debug mode', () => {
  it('As a dotli developer, I open a page with ?debug=true and the panel starts expanded, remembered for the tab and gone from the URL', () => {
    // Given
    const storage = createMemoryStorage();
    const tab = createPage('https://app.dot.li/path?x=1&debug=true#top', storage);

    // When
    const mode = resolveDebugMode(tab, false);

    // Then
    expect(mode).toEqual({ enabled: true, explicit: true });
    expect(storage.getItem('dotli:truapi-debug')).toBe('1');
    expect(tab.replaceState).toHaveBeenCalledWith(null, '', '/path?x=1#top');
  });

  it('As a dotli developer, I open a page with ?debug=off on a debug build and the panel stays off', () => {
    // Given
    const storage = createMemoryStorage();
    const tab = createPage('https://app.dot.li/?debug=off', storage);

    // When
    const mode = resolveDebugMode(tab, true);

    // Then
    expect(mode).toEqual({ enabled: false, explicit: true });
    expect(storage.getItem('dotli:truapi-debug')).toBe('0');
    expect(tab.replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('As a dotli developer, I follow the debug mode link of a page and it opens with the panel on', () => {
    // Given
    const href = getDebugModeUrl('https://app.dot.li/path?x=1#top');

    // When
    const mode = resolveDebugMode(createPage(href), false);

    // Then
    expect(mode).toEqual({ enabled: true, explicit: true });
  });

  it('As a dotli developer who turned debug mode on earlier in this tab, I reload and it stays on', () => {
    // Given
    const tab = createPage('https://app.dot.li/', createMemoryStorage({ entries: { 'dotli:truapi-debug': '1' } }));

    // When
    const mode = resolveDebugMode(tab, false);

    // Then
    expect(mode).toEqual({ enabled: true, explicit: true });
    expect(tab.replaceState).not.toHaveBeenCalled();
  });

  it('As a visitor who never chose, I get what the build decides and the panel starts collapsed', () => {
    // Given
    const storage = createMemoryStorage();
    const tab = createPage('https://app.dot.li/?debug=maybe', storage);

    // When
    const mode = resolveDebugMode(tab, true);

    // Then
    expect(mode).toEqual({ enabled: true, explicit: false });
    expect(storage.length).toBe(0);
    expect(tab.replaceState).not.toHaveBeenCalled();
  });

  it('As a visitor whose browser blocks storage, I get what the build decides and the failed read is reported', () => {
    // Given
    const reports = recordReports({ onFinished: onTestFinished });
    const tab = createPage('https://app.dot.li/', BLOCKED_STORAGE);

    // When
    const mode = resolveDebugMode(tab, false);

    // Then
    expect(mode).toEqual({ enabled: false, explicit: false });
    expect(reports.expected).toMatchObject([{ step: 'debug_mode_read' }]);
  });

  it('As a visitor whose browser blocks storage, I open a page with ?debug=true and get the panel while the param leaves the URL', () => {
    // Given
    const reports = recordReports({ onFinished: onTestFinished });
    const tab = createPage('https://app.dot.li/path?x=1&debug=true#top', BLOCKED_STORAGE);

    // When
    const mode = resolveDebugMode(tab, false);

    // Then
    expect(mode).toEqual({ enabled: true, explicit: true });
    expect(tab.replaceState).toHaveBeenCalledWith(null, '', '/path?x=1#top');
    expect(reports.expected).toMatchObject([{ step: 'debug_mode_write' }]);
  });

  it('As a dotli developer whose page refuses a history update, I open a page with ?debug=true and still get the panel', () => {
    // Given
    const reports = recordReports({ onFinished: onTestFinished });
    const tab = createPage('https://app.dot.li/?debug=true');
    tab.replaceState.mockImplementation(throwBlocked);

    // When
    const mode = resolveDebugMode(tab, false);

    // Then
    expect(mode).toEqual({ enabled: true, explicit: true });
    expect(reports.expected).toMatchObject([{ step: 'debug_param_strip' }]);
  });

  it('As a dotli developer who turned debug mode on in this tab, I check it and it reads as on', () => {
    // Given
    const tab = createPage('https://app.dot.li/', createMemoryStorage({ entries: { 'dotli:truapi-debug': '1' } }));

    // When
    const debugModeOn = isDebugModeOn(tab);

    // Then
    expect(debugModeOn).toBe(true);
  });

  it('As a dotli developer, I close the panel and debug mode is off for the tab', () => {
    // Given
    const tab = createPage('https://app.dot.li/', createMemoryStorage({ entries: { 'dotli:truapi-debug': '1' } }));

    // When
    leaveDebugMode(tab);
    const debugModeOn = isDebugModeOn(tab);
    const resolved = resolveDebugMode(tab, true);

    // Then
    expect(debugModeOn).toBe(false);
    expect(resolved).toEqual({ enabled: false, explicit: true });
  });

  it('As a visitor whose browser blocks storage, I close the panel without an error and debug mode reads as off', () => {
    // Given
    const tab = createPage('https://app.dot.li/', BLOCKED_STORAGE);

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
