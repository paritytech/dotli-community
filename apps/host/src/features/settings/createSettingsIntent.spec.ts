// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createSettingsIntent } from './createSettingsIntent.js';

type Params = {
  intent: ReturnType<typeof createSettingsIntent>;
};

describe('createSettingsIntent', () => {
  it('As a visitor whose load failed, I press Open settings twice and the settings open each time', () => {
    // Given
    const intent = createSettingsIntent();
    const settings = mountPopover({ intent });

    // When
    intent.open();
    intent.open();

    // Then
    expect(settings.countOpened()).toBe(2);
  });

  it('As a visitor whose load failed before the settings button was on the page, I ask for the settings and they open once it is', () => {
    // Given
    const intent = createSettingsIntent();
    intent.open();

    // When
    const settings = mountPopover({ intent });

    // Then
    expect(settings.countOpened()).toBe(1);
  });

  it('As a visitor whose settings button went away, I ask for the settings and the next settings button opens them', () => {
    // Given a popover that mounted, then unmounted
    const intent = createSettingsIntent();
    const gone = mountPopover({ intent });
    gone.unmount();

    // When
    intent.open();
    const next = mountPopover({ intent });

    // Then
    expect({ gone: gone.countOpened(), next: next.countOpened() }).toEqual({ gone: 0, next: 1 });
  });

  it('As a visitor, I leave settings open on a bar that went away and they stay closed on the next bar', () => {
    // Given a popover opened, then unmounted
    const intent = createSettingsIntent();
    const gone = mountPopover({ intent });
    intent.open();
    gone.unmount();

    // When
    const next = mountPopover({ intent });

    // Then
    expect({ gone: gone.countOpened(), next: next.countOpened() }).toEqual({ gone: 1, next: 0 });
  });
});

/** Mounts a settings popover on `intent` that counts how often it is asked to open. */
function mountPopover({ intent }: Params) {
  let opened = 0;
  const unmount = intent.registerOpener(() => {
    opened += 1;
  });
  return {
    /** Returns how often the popover was asked to open. */
    countOpened: () => opened,
    /** Takes the popover off the page. */
    unmount,
  };
}
