// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, type EnforceablePermissionName, type PermissionStatus } from '../policy/permissionPolicy.js';
import { presetOf, RESTRICTED, SECURE, TRUSTED, type Preset } from './presets.js';

/** A preset's statuses in menu order, with `changes` laid over them. */
function from(
  base: Preset,
  changes: Partial<Record<EnforceablePermissionName, PermissionStatus>> = {},
): PermissionStatus[] {
  return ALL_PERMISSIONS.map(({ name }) => changes[name] ?? base.statuses[name]);
}

describe('permission presets', () => {
  // Unlimited sets the statuses Trusted sets, so they read as the safer Trusted.
  it.each([RESTRICTED, SECURE, TRUSTED])(
    'As the slider, statuses equal to $label read as $label, not modified',
    preset => {
      // When
      const shown = presetOf(from(preset));

      // Then
      expect(shown).toEqual({ preset, modified: false });
    },
  );

  it.each<[string, Preset, Partial<Record<EnforceablePermissionName, PermissionStatus>>, Preset]>([
    ['Secure with Location blocked', SECURE, { Location: 'denied' }, SECURE],
    [
      'Secure with Notifications and identity allowed',
      SECURE,
      { Notifications: 'granted', IdentityDisclosure: 'granted' },
      SECURE,
    ],
    ['Trusted with Sign transactions at Ask', TRUSTED, { ChainSubmit: 'ask' }, TRUSTED],
    ['Trusted with Camera blocked', TRUSTED, { Camera: 'denied' }, TRUSTED],
    ['Restricted with Camera left to the browser', RESTRICTED, { Camera: 'ask' }, RESTRICTED],
    [
      'Secure with seven device permissions denied',
      SECURE,
      {
        Camera: 'denied',
        Microphone: 'denied',
        Location: 'denied',
        Motion: 'denied',
        Bluetooth: 'denied',
        Clipboard: 'denied',
        Biometrics: 'denied',
      },
      RESTRICTED,
    ],
  ])('As the slider, %s reads as the closest preset, modified', (_case, base, changes, closest) => {
    // Given
    const statuses = from(base, changes);

    // When
    const shown = presetOf(statuses);

    // Then
    expect(shown).toEqual({ preset: closest, modified: true });
  });
});
