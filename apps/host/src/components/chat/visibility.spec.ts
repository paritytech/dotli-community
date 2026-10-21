// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { visibilityWatcher } from './visibility.js';

/** Stands in for the browser's IntersectionObserver, scrolled by the test. */
class FakeObserver {
  static last: FakeObserver | undefined;
  observed: unknown[] = [];
  disconnected = false;
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeObserver.last = this;
  }

  observe(el: unknown): void {
    this.observed.push(el);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  scroll(isIntersecting: boolean): void {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

const row = {} as Element;

describe('visibilityWatcher', () => {
  it('As a user, without IntersectionObserver a message counts as in view at once', () => {
    // Given
    const seen: boolean[] = [];

    // When
    visibilityWatcher(undefined)(row, visible => seen.push(visible));

    // Then
    expect(seen).toEqual([true]);
  });

  it('As a user, a message is in view only while the observer says so, until it stops watching', () => {
    // Given
    const seen: boolean[] = [];
    const stop = visibilityWatcher(FakeObserver as unknown as typeof IntersectionObserver)(row, visible =>
      seen.push(visible),
    );
    const observer = FakeObserver.last;

    // When
    observer?.scroll(true);
    observer?.scroll(false);
    stop();

    // Then
    expect(observer?.observed).toEqual([row]);
    expect(seen).toEqual([true, false]);
    expect(observer?.disconnected).toBe(true);
  });
});
