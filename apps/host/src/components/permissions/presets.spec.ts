// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  type EnforceablePermissionName,
  type PermissionStatus,
} from '../../runtime/permissionPolicy.js';
import { distance, PRESETS, presetOf, RESTRICTED, SECURE, TRUSTED, UNLIMITED, type Preset } from './presets.js';

/** A preset's statuses in menu order, with `changes` laid over them. */
function from(
  base: Preset,
  changes: Partial<Record<EnforceablePermissionName, PermissionStatus>> = {},
): PermissionStatus[] {
  return ALL_PERMISSIONS.map(({ name }) => changes[name] ?? base.statuses[name]);
}

describe('permission presets', () => {
  it('As the slider, I lay the presets out safest first', () => {
    // Then
    expect(PRESETS.map(preset => preset.id)).toEqual(['restricted', 'secure', 'trusted', 'unlimited']);
  });

  it('As a user, Trusted allows the account, chain, camera, microphone, clipboard and notifications and asks for the rest', () => {
    // Given
    const names = ALL_PERMISSIONS.map(({ name }) => name);

    // When
    const granted = names.filter(name => TRUSTED.statuses[name] === 'granted');
    const others = new Set(names.filter(name => !granted.includes(name)).map(name => TRUSTED.statuses[name]));

    // Then
    expect(granted).toEqual([
      'Notifications',
      'Camera',
      'Microphone',
      'Clipboard',
      'IdentityDisclosure',
      'ChainSubmit',
      'PreimageSubmit',
      'StatementSubmit',
    ]);
    expect(others).toEqual(new Set(['ask']));
  });

  it.each(PRESETS)('As the slider, statuses equal to $label read as $label, not modified', preset => {
    // When
    const shown = presetOf(from(preset));

    // Then
    expect(shown).toEqual({ preset, modified: false });
    expect(distance(from(preset), preset)).toBe(0);
  });

  it.each<[string, Preset, Partial<Record<EnforceablePermissionName, PermissionStatus>>, Preset, number]>([
    ['Secure with Location denied', SECURE, { Location: 'denied' }, SECURE, 1],
    ['Secure with Camera allowed', SECURE, { Camera: 'granted' }, SECURE, 1],
    [
      'Secure with Notifications, Clipboard, Camera and Microphone allowed',
      SECURE,
      { Notifications: 'granted', Clipboard: 'granted', Camera: 'granted', Microphone: 'granted' },
      SECURE,
      4,
    ],
    ['Trusted with Location allowed', TRUSTED, { Location: 'granted' }, TRUSTED, 1],
    ['Trusted with Location and Bluetooth allowed', TRUSTED, { Location: 'granted', Bluetooth: 'granted' }, TRUSTED, 2],
    [
      'Trusted with Location, Bluetooth and NFC allowed',
      TRUSTED,
      { Location: 'granted', Bluetooth: 'granted', NFC: 'granted' },
      UNLIMITED,
      2,
    ],
    ['Unlimited with Camera denied', UNLIMITED, { Camera: 'denied' }, UNLIMITED, 2],
    ['Restricted with Camera at Ask', RESTRICTED, { Camera: 'ask' }, RESTRICTED, 1],
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
      6,
    ],
  ])('As the slider, %s reads as the closest preset, modified', (_case, base, changes, closest, steps) => {
    // Given
    const statuses = from(base, changes);

    // When
    const shown = presetOf(statuses);
    const measured = distance(statuses, closest);

    // Then
    expect(measured).toBe(steps);
    expect(shown).toEqual({ preset: closest, modified: true });
  });

  it('As the slider, Trusted with every asked device permission allowed reads as Unlimited, not modified', () => {
    // Given
    const statuses = ALL_PERMISSIONS.map(({ name }) =>
      TRUSTED.statuses[name] === 'ask' ? 'granted' : TRUSTED.statuses[name],
    );

    // When
    const shown = presetOf(statuses);

    // Then
    expect(shown).toEqual({ preset: UNLIMITED, modified: false });
  });
});
