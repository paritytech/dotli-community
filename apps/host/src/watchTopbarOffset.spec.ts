// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { watchTopbarOffset } from './watchTopbarOffset.js';

type Device = { mobile?: boolean; phone?: boolean };

describe('The topbar offset', () => {
  it('As a desktop user, I see the app take the full height under the bar', () => {
    // Given
    const page = setupPage();

    // When
    page.watch();

    // Then
    expect(page.offsets).toEqual([false]);
  });

  it('As a tablet user, I see the app start below the bar, which never folds', () => {
    // Given
    const page = setupPage({ mobile: true });

    // When
    page.watch();

    // Then
    expect(page.offsets).toEqual([true]);
  });

  it('As a user, I narrow the window to a phone width and the app keeps clear of the bar, and widening it gives the app the full height again', () => {
    // Given
    const page = setupPage();
    page.watch();

    // When
    page.setPhone(true);
    page.setPhone(false);

    // Then
    expect(page.offsets).toEqual([false, true, false]);
  });

  it('As a user, I stop the watch and a phone width moves the app no more', () => {
    // Given
    const page = setupPage();
    const stop = page.watch();

    // When
    stop();
    page.setPhone(true);

    // Then
    expect(page.offsets).toEqual([false]);
  });
});

function setupPage({ mobile = false, phone = false }: Device = {}) {
  const device = { mobile, phone };
  const watchers = new Set<() => void>();
  const offsets: boolean[] = [];
  return {
    /** Every offset the layout was asked for, in order. */
    offsets,
    watch: () =>
      watchTopbarOffset({
        isMobile: () => device.mobile,
        isPhone: () => device.phone,
        watchPhone(onChange) {
          watchers.add(onChange);
          return () => {
            watchers.delete(onChange);
          };
        },
        layout: {
          setTopbarLayout({ offset }) {
            offsets.push(offset);
          },
        },
      }),
    setPhone(next: boolean) {
      device.phone = next;
      for (const watcher of [...watchers]) {
        watcher();
      }
    },
  };
}
