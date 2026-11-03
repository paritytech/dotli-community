// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { createPhoneViewport } from './phoneViewport.js';

/**
 * A viewport whose media query answers `phone` until it is resized. A browser updates the answer on the window's
 * resize and fires `change` after it, so `resize` does both and `crossBreakpoint` only the first.
 */
function createFakeViewport(phone: boolean) {
  let matches = phone;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const query = {
    get matches() {
      return matches;
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'change') {
        listeners.add(listener);
      }
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'change') {
        listeners.delete(listener);
      }
    },
  };

  return {
    matchMedia: (_query: string) => query,
    crossBreakpoint,
    resize(next: boolean): void {
      crossBreakpoint(next);
      fireChange();
    },
  };

  function crossBreakpoint(next: boolean): void {
    matches = next;
  }

  function fireChange(): void {
    const event = new Event('change');
    for (const listener of listeners) {
      if (typeof listener === 'function') {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }
}

describe('phone viewport', () => {
  it('As a page on a phone, I read true, and a listener hears false when the viewport widens', () => {
    // Given: a phone viewport with a listener.
    const viewport = createFakeViewport(true);
    const phone = createPhoneViewport({ matchMedia: viewport.matchMedia });
    const heard: boolean[] = [];
    onTestFinished(phone.store.listen(next => heard.push(next)));

    // When: the page reads it, then the viewport widens.
    const read = phone.isPhone();
    viewport.resize(false);

    // Then
    expect(read).toBe(true);
    expect(heard).toEqual([false]);
  });

  it('As a build-time render, I read false', () => {
    // Given: no media query to ask.
    const phone = createPhoneViewport({ matchMedia: undefined });

    // When
    const reads = [phone.isPhone(), phone.store.get()];

    // Then
    expect(reads).toEqual([false, false]);
  });

  it('As a caller with no reader, I read the current answer', () => {
    // Given: a phone viewport that nothing listens to.
    const viewport = createFakeViewport(true);
    const phone = createPhoneViewport({ matchMedia: viewport.matchMedia });

    // When: the caller reads it before and after the viewport widens.
    const reads = [phone.isPhone()];
    viewport.resize(false);
    reads.push(phone.isPhone());

    // Then
    expect(reads).toEqual([true, false]);
  });

  it("As a resize handler, I read the new answer before the media query's change event fires", () => {
    // Given: a phone viewport that a listener keeps following.
    const viewport = createFakeViewport(true);
    const phone = createPhoneViewport({ matchMedia: viewport.matchMedia });
    const heard: boolean[] = [];
    onTestFinished(phone.store.listen(next => heard.push(next)));

    // When: the window widens past the breakpoint and its resize handler reads, before any `change`.
    viewport.crossBreakpoint(false);
    const read = phone.isPhone();

    // Then
    expect(read).toBe(false);
    expect(heard).toEqual([]);
  });
});
