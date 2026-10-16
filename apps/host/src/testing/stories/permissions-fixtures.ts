// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The permissions a story gives the permissions button and panel. Plays move them the way the page's stores do, and the
// recorded calls stand in for the runtime's intents, which apply a change as the store would.

import { createSignal, flush } from 'solid-js';
import { fn } from 'storybook/test';
import type { EnforceablePermissionName, PermissionStatus, PermissionTargets } from '../../runtime/permissions.js';
import type { MenuPermission, PermissionsNotice } from '../../components/permissions/permissions.js';
import type { PermissionsItemProps } from '../../components/permissions/PermissionsItem.js';

/** The runtime's menu, in its order. */
export const STORY_PERMISSIONS: readonly MenuPermission[] = [
  { name: 'Notifications', label: 'Notifications', group: 'device' },
  { name: 'Camera', label: 'Camera', group: 'device' },
  { name: 'Microphone', label: 'Microphone', group: 'device' },
  { name: 'Location', label: 'Location', group: 'device' },
  { name: 'Bluetooth', label: 'Bluetooth', group: 'device' },
  { name: 'NFC', label: 'NFC', group: 'device' },
  { name: 'Clipboard', label: 'Clipboard', group: 'device' },
  { name: 'Biometrics', label: 'Biometrics', group: 'device' },
  { name: 'IdentityDisclosure', label: 'Identity disclosure', group: 'app' },
  { name: 'ChainSubmit', label: 'Sign transactions', group: 'app' },
  { name: 'PreimageSubmit', label: 'Submit preimages', group: 'app' },
  { name: 'StatementSubmit', label: 'Submit statements', group: 'app' },
];

const [notice, setNotice] = createSignal<PermissionsNotice | undefined>('loading');
const [statuses, setStatuses] = createSignal<readonly PermissionStatus[] | undefined>(undefined);
const [hasGrants, setHasGrants] = createSignal(false);
const [pending, setPending] = createSignal(false);

// A held change stays pending until the story releases it.
let held: PromiseWithResolvers<undefined> | null = null;
let refused: readonly EnforceablePermissionName[] = [];
let asked: Promise<unknown>[] = [];

/** What the panel asked of the page. */
export const permissionsAsked = {
  opens: 0,
  changes: fn<(targets: PermissionTargets) => void>(),
};

function write(next: readonly PermissionStatus[] | undefined): void {
  setStatuses(next);
  setHasGrants(next?.includes('granted') ?? false);
  flush();
}

function laidOver(base: readonly PermissionStatus[], targets: PermissionTargets): PermissionStatus[] {
  return base.map((was, i) => {
    const name = STORY_PERMISSIONS[i]?.name;
    return name === undefined ? was : (targets[name] ?? was);
  });
}

/** The props a page gives the permissions button. */
export const storyPermissions: PermissionsItemProps = {
  permissions: STORY_PERMISSIONS,
  hasGrants,
  notice,
  statuses,
  pending,
  onOpen: () => {
    permissionsAsked.opens += 1;
  },
  onChange: targets => {
    const change = applyChange(targets);
    asked.push(change);
    return change;
  },
};

async function applyChange(targets: PermissionTargets): Promise<EnforceablePermissionName[]> {
  permissionsAsked.changes(targets);
  const refusing = refused;
  const before = statuses();
  if (before === undefined) {
    return [];
  }
  write(laidOver(before, targets));
  const hold = held;
  if (hold !== null) {
    setPending(true);
    flush();
    await hold.promise;
    setPending(false);
    flush();
  }
  const failed = STORY_PERMISSIONS.map(({ name }) => name).filter(
    name => refusing.includes(name) && targets[name] !== undefined,
  );
  if (failed.length > 0) {
    // A refused write leaves the status the core had before.
    const kept = Object.fromEntries(
      failed.map(name => [name, before[STORY_PERMISSIONS.findIndex(perm => perm.name === name)] ?? 'ask']),
    );
    write(laidOver(statuses() ?? before, kept));
  }
  return failed;
}

/**
 * Resolves once every change asked for has settled, the panel has taken each outcome, and the page shows what it made of
 * them. The panel takes each outcome first, as it asked for the change before a play can wait on it.
 */
export async function changesSettled(): Promise<void> {
  await Promise.all(asked);
  flush();
}

/** A loaded app on `app.dot` whose statuses read as `granted` says, Ask for the rest. */
export function givenApp(granted: Partial<Record<EnforceablePermissionName, PermissionStatus>> = {}): void {
  setNotice(undefined);
  write(STORY_PERMISSIONS.map(({ name }) => granted[name] ?? 'ask'));
}

/** No statuses to show, and why. */
export function givenNotice(next: PermissionsNotice): void {
  setNotice(next);
  write(undefined);
}

/** Every permission read as `status`, as a newer read lands. */
export function readAll(status: PermissionStatus): void {
  write(STORY_PERMISSIONS.map(() => status));
}

/** Holds every change asked for from now on pending until the returned release, or until a newer hold takes over. */
export function holdChanges(): () => void {
  const hold = Promise.withResolvers<undefined>();
  held = hold;
  return () => {
    if (held === hold) {
      held = null;
    }
    hold.resolve(undefined);
  };
}

/** The core refuses every write of `names` in a change asked for from now on, until a newer call or the reset. */
export function refuseChanges(names: readonly EnforceablePermissionName[]): void {
  refused = names;
}

/** For a story's `beforeEach`: no app loaded yet, nothing asked, nothing held or refused. */
export function resetStoryPermissions(): void {
  givenNotice('loading');
  permissionsAsked.opens = 0;
  permissionsAsked.changes.mockClear();
  held = null;
  refused = [];
  asked = [];
  setPending(false);
}
