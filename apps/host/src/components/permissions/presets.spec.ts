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
    // Then
    expect(TRUSTED.statuses).toEqual({
      Notifications: 'granted',
      Camera: 'granted',
      Microphone: 'granted',
      Location: 'ask',
      Motion: 'ask',
      Bluetooth: 'ask',
      NFC: 'ask',
      Clipboard: 'granted',
      Biometrics: 'ask',
      IdentityDisclosure: 'granted',
      ChainSubmit: 'granted',
      PreimageSubmit: 'granted',
      StatementSubmit: 'granted',
    });
  });

  it.each(PRESETS)('As the slider, statuses equal to $label read as $label, not modified', preset => {
    // When
    const shown = presetOf(from(preset));

    // Then
    expect(shown).toEqual({ preset, modified: false });
    expect(distance(from(preset), preset)).toBe(0);
  });

  it.each<[string, Preset, Partial<Record<EnforceablePermissionName, PermissionStatus>>, number[], Preset]>([
    ['Secure with Location denied', SECURE, { Location: 'denied' }, [12, 1, 9, 14], SECURE],
    ['Secure with Camera allowed', SECURE, { Camera: 'granted' }, [14, 1, 7, 12], SECURE],
    [
      'Secure with Notifications, Clipboard, Camera and Microphone allowed',
      SECURE,
      { Notifications: 'granted', Clipboard: 'granted', Camera: 'granted', Microphone: 'granted' },
      [17, 4, 4, 9],
      SECURE,
    ],
    ['Trusted with Location allowed', TRUSTED, { Location: 'granted' }, [22, 9, 1, 4], TRUSTED],
    [
      'Trusted with Location and Bluetooth allowed',
      TRUSTED,
      { Location: 'granted', Bluetooth: 'granted' },
      [23, 10, 2, 3],
      TRUSTED,
    ],
    [
      'Trusted with Location, Bluetooth and NFC allowed',
      TRUSTED,
      { Location: 'granted', Bluetooth: 'granted', NFC: 'granted' },
      [24, 11, 3, 2],
      UNLIMITED,
    ],
    ['Unlimited with Camera denied', UNLIMITED, { Camera: 'denied' }, [24, 13, 7, 2], UNLIMITED],
    ['Restricted with Camera at Ask', RESTRICTED, { Camera: 'ask' }, [1, 12, 20, 25], RESTRICTED],
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
      [6, 7, 15, 20],
      RESTRICTED,
    ],
  ])('As the slider, %s reads as the closest preset, modified', (_case, base, changes, distances, closest) => {
    // Given
    const statuses = from(base, changes);

    // When
    const shown = presetOf(statuses);

    // Then
    expect(PRESETS.map(preset => distance(statuses, preset))).toEqual(distances);
    expect(shown).toEqual({ preset: closest, modified: true });
  });

  it('As the slider, Trusted with every asked device permission allowed reads as Unlimited, not modified', () => {
    // When
    const shown = presetOf(
      from(TRUSTED, {
        Location: 'granted',
        Motion: 'granted',
        Bluetooth: 'granted',
        NFC: 'granted',
        Biometrics: 'granted',
      }),
    );

    // Then
    expect(shown).toEqual({ preset: UNLIMITED, modified: false });
  });
});
