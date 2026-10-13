// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { openSettings, registerSettingsOpener } from './settings-intent.js';
import { resetAllStoresForTests } from '@dotli/shared/testing';

const unregisters: (() => void)[] = [];

/** A settings popover that counts how often it is asked to open. */
function popover(): { opened: number } {
  const counts = { opened: 0 };
  unregisters.push(
    registerSettingsOpener(() => {
      counts.opened += 1;
    }),
  );
  return counts;
}

afterEach(() => {
  for (const unregister of unregisters.splice(0)) {
    unregister();
  }
  resetAllStoresForTests();
});

describe('Open settings intent', () => {
  it('As a visitor whose load failed, Open settings opens the settings, and asking again after I closed them opens them again', () => {
    // Given
    const settings = popover();

    // When
    openSettings();
    openSettings();

    // Then
    expect(settings.opened).toBe(2);
  });

  it('As a visitor whose load failed before the settings button was on the page, the settings open once it is', () => {
    // Given
    openSettings();

    // When
    const settings = popover();

    // Then
    expect(settings.opened).toBe(1);
  });

  it('As a visitor whose settings button went away, I ask for the settings and the next settings button opens them', () => {
    // Given a popover that mounted, then unmounted
    const gone = popover();
    unregisters.pop()?.();

    // When
    openSettings();
    const next = popover();

    // Then
    expect(gone.opened).toBe(0);
    expect(next.opened).toBe(1);
  });

  it('As a visitor, settings I left open on a bar that went away stay closed on the next bar', () => {
    // Given a popover opened, then unmounted
    const gone = popover();
    openSettings();
    unregisters.pop()?.();

    // When
    const next = popover();

    // Then
    expect(gone.opened).toBe(1);
    expect(next.opened).toBe(0);
  });
});
