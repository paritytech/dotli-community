// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { isPhoneViewport, watchPhoneViewport } from './phoneViewport.js';

/**
 * A viewport whose media query answers `phone` until it is resized. A browser updates the answer on the window's
 * resize and fires `change` after it, so `resize` does both and `crossBreakpoint` only the first.
 */
function createFakeViewport(phone: boolean) {
  const query = Object.assign(new EventTarget(), { matches: phone });

  return {
    matchMedia: (_query: string) => query,
    crossBreakpoint,
    resize(next: boolean): void {
      crossBreakpoint(next);
      query.dispatchEvent(new Event('change'));
    },
  };

  function crossBreakpoint(next: boolean): void {
    query.matches = next;
  }
}

describe('phone viewport', () => {
  it('As a page on a phone, I read true, and a listener hears false when the viewport widens', () => {
    // Given: a phone viewport with a listener.
    const viewport = createFakeViewport(true);
    const heard: boolean[] = [];
    onTestFinished(watchPhoneViewport(next => heard.push(next), viewport));

    // When: the page reads it, then the viewport widens.
    const read = isPhoneViewport(viewport);
    viewport.resize(false);

    // Then
    expect(read).toBe(true);
    expect(heard).toEqual([false]);
  });

  it('As a build-time render, I read false and a watcher is never called', () => {
    // Given: no media query to ask, and a watcher.
    const heard: boolean[] = [];
    onTestFinished(watchPhoneViewport(next => heard.push(next), { matchMedia: null }));

    // When
    const read = isPhoneViewport({ matchMedia: null });

    // Then
    expect(read).toBe(false);
    expect(heard).toEqual([]);
  });

  it("As a resize handler, I read the new answer before the media query's change event fires", () => {
    // Given: a phone viewport that a listener keeps following.
    const viewport = createFakeViewport(true);
    const heard: boolean[] = [];
    onTestFinished(watchPhoneViewport(next => heard.push(next), viewport));

    // When: the window widens past the breakpoint and its resize handler reads, before any `change`.
    viewport.crossBreakpoint(false);
    const read = isPhoneViewport(viewport);

    // Then
    expect(read).toBe(false);
    expect(heard).toEqual([]);
  });
});
