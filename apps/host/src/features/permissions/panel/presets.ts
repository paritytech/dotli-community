// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The three presets the permissions slider offers, and which one a set of statuses reads as. A preset is never stored,
// it is read from the statuses each time.

import {
  PERMISSION_NAMES,
  PERMISSION_CATALOG,
  type EnforceablePermissionName,
  type PermissionStatus,
} from '../policy/permissionPolicy.js';

export type PresetId = 'restricted' | 'secure' | 'trusted';

export type Preset = {
  id: PresetId;
  label: string;
  /** Who the preset is for, shown under the slider. */
  line: string;
  statuses: Readonly<Record<EnforceablePermissionName, PermissionStatus>>;
};

export const RESTRICTED: Preset = {
  id: 'restricted',
  label: 'Restricted',
  line: "For apps you don't trust.",
  statuses: mapStatuses(() => 'denied'),
};

export const SECURE: Preset = {
  id: 'secure',
  label: 'Secure',
  line: 'Decide each time the app asks.',
  statuses: mapStatuses(() => 'ask'),
};

export const TRUSTED: Preset = {
  id: 'trusted',
  label: 'Trusted',
  line: 'For apps you use often.',
  statuses: mapStatuses(name => PERMISSION_CATALOG[name].trusted),
};

/** Safest first, as the slider lays them out. */
export const PRESETS = [RESTRICTED, SECURE, TRUSTED] as const;

// Deny, Ask and Allow lie on one line, so Deny against Allow is two steps apart.
const RANK: Readonly<Record<PermissionStatus, number>> = { denied: 0, ask: 1, granted: 2 };

/** The steps from `statuses`, in menu order, to `preset`. */
function distance(statuses: readonly PermissionStatus[], preset: Preset): number {
  return PERMISSION_NAMES.reduce(
    (sum, name, i) => sum + Math.abs(RANK[statuses[i] ?? 'ask'] - RANK[preset.statuses[name]]),
    0,
  );
}

export type ShownPreset = {
  preset: Preset;
  /** The statuses differ from the preset. */
  modified: boolean;
};

/** The preset closest to `statuses`, in menu order, the safer one on a tie. */
export function presetOf(statuses: readonly PermissionStatus[]): ShownPreset {
  const measured = PRESETS.map(preset => ({ preset, steps: distance(statuses, preset) }));
  // Only a strictly closer preset wins, so a tie keeps the safer one found first.
  const closest = measured.reduce((best, next) => (next.steps < best.steps ? next : best));
  return { preset: closest.preset, modified: closest.steps > 0 };
}

function mapStatuses(
  read: (name: EnforceablePermissionName) => PermissionStatus,
): Record<EnforceablePermissionName, PermissionStatus> {
  return Object.fromEntries(PERMISSION_NAMES.map(name => [name, read(name)])) as Record<
    EnforceablePermissionName,
    PermissionStatus
  >;
}
