// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The four presets the permissions slider offers, and which one a set of statuses reads as. A preset is never stored,
// it is read from the statuses each time.

import { ALL_PERMISSIONS, type EnforceablePermissionName, type PermissionStatus } from '../../runtime/permissions.js';

export type PresetId = 'restricted' | 'secure' | 'trusted' | 'unlimited';

export interface Preset {
  id: PresetId;
  label: string;
  /** Who the preset is for, shown under the slider. */
  line: string;
  statuses: Readonly<Record<EnforceablePermissionName, PermissionStatus>>;
}

function every(status: PermissionStatus): Record<EnforceablePermissionName, PermissionStatus> {
  return Object.fromEntries(ALL_PERMISSIONS.map(({ name }) => [name, status])) as Record<
    EnforceablePermissionName,
    PermissionStatus
  >;
}

export const RESTRICTED: Preset = {
  id: 'restricted',
  label: 'Restricted',
  line: "For apps you don't trust.",
  statuses: every('denied'),
};

export const SECURE: Preset = {
  id: 'secure',
  label: 'Secure',
  line: 'Decide each time the app asks.',
  statuses: every('ask'),
};

// Spelled out, so a permission added to the menu fails the type check until Trusted gives it a status.
export const TRUSTED: Preset = {
  id: 'trusted',
  label: 'Trusted',
  line: 'For apps you use often.',
  statuses: {
    Notifications: 'granted',
    Camera: 'granted',
    Microphone: 'granted',
    Location: 'ask',
    Bluetooth: 'ask',
    NFC: 'ask',
    Clipboard: 'granted',
    Biometrics: 'ask',
    IdentityDisclosure: 'granted',
    ChainSubmit: 'granted',
    PreimageSubmit: 'granted',
    StatementSubmit: 'granted',
  },
};

export const UNLIMITED: Preset = {
  id: 'unlimited',
  label: 'Unlimited',
  line: 'For apps you fully trust.',
  statuses: every('granted'),
};

/** Safest first, as the slider lays them out. */
export const PRESETS = [RESTRICTED, SECURE, TRUSTED, UNLIMITED] as const;

// Deny, Ask and Allow lie on one line, so Deny against Allow is two steps apart.
const RANK: Readonly<Record<PermissionStatus, number>> = { denied: 0, ask: 1, granted: 2 };

/** The steps from `statuses`, in menu order, to `preset`. */
export function distance(statuses: readonly PermissionStatus[], preset: Preset): number {
  return ALL_PERMISSIONS.reduce(
    (sum, { name }, i) => sum + Math.abs(RANK[statuses[i] ?? 'ask'] - RANK[preset.statuses[name]]),
    0,
  );
}

export interface ShownPreset {
  preset: Preset;
  /** The statuses differ from the preset. */
  modified: boolean;
}

/** The preset closest to `statuses`, in menu order, the safer one on a tie. */
export function presetOf(statuses: readonly PermissionStatus[]): ShownPreset {
  let closest: Preset = RESTRICTED;
  let least = distance(statuses, RESTRICTED);
  for (const preset of PRESETS) {
    const steps = distance(statuses, preset);
    // Only a strictly closer preset wins, so a tie keeps the safer one found first.
    if (steps < least) {
      closest = preset;
      least = steps;
    }
  }
  return { preset: closest, modified: least > 0 };
}
