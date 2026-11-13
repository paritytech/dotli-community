// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  type EnforceablePermissionName,
  type PermissionStatus,
} from '../../runtime/permissionPolicy.js';
import { PRESETS, presetOf, RESTRICTED, SECURE, TRUSTED, UNLIMITED, type Preset } from './presets.js';

/** A preset's statuses in menu order, with `changes` laid over them. */
function from(
  base: Preset,
  changes: Partial<Record<EnforceablePermissionName, PermissionStatus>> = {},
): PermissionStatus[] {
  return ALL_PERMISSIONS.map(({ name }) => changes[name] ?? base.statuses[name]);
}

describe('permission presets', () => {
  it.each(PRESETS)('As the slider, statuses equal to $label read as $label, not modified', preset => {
    // When
    const shown = presetOf(from(preset));

    // Then
    expect(shown).toEqual({ preset, modified: false });
  });

  it.each<[string, Preset, Partial<Record<EnforceablePermissionName, PermissionStatus>>, Preset]>([
    ['Secure with Location denied', SECURE, { Location: 'denied' }, SECURE],
    ['Secure with Camera allowed', SECURE, { Camera: 'granted' }, SECURE],
    [
      'Secure with Notifications, Clipboard, Camera and Microphone allowed',
      SECURE,
      { Notifications: 'granted', Clipboard: 'granted', Camera: 'granted', Microphone: 'granted' },
      SECURE,
    ],
    ['Trusted with Location allowed', TRUSTED, { Location: 'granted' }, TRUSTED],
    ['Trusted with Location and Bluetooth allowed', TRUSTED, { Location: 'granted', Bluetooth: 'granted' }, TRUSTED],
    [
      'Trusted with Location, Bluetooth and NFC allowed',
      TRUSTED,
      { Location: 'granted', Bluetooth: 'granted', NFC: 'granted' },
      UNLIMITED,
    ],
    ['Unlimited with Camera denied', UNLIMITED, { Camera: 'denied' }, UNLIMITED],
    ['Restricted with Camera at Ask', RESTRICTED, { Camera: 'ask' }, RESTRICTED],
    [
      'Secure with seven device permissions denied',
      SECURE,
      {
        Camera: 'denied',
        Microphone: 'denied',
        Location: 'denied',
        Motion: 'denied',
        Bluetooth: 'denied',
        NFC: 'denied',
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
