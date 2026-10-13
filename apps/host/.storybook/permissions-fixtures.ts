// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The permissions a story gives the permissions button and panel. Plays move them the way the page's stores do, and the
// recorded calls stand in for the runtime's intents, which apply a change as the store would.

import { createSignal, flush } from 'solid-js';
import { fn } from 'storybook/test';
import type { EnforceablePermissionName, PermissionStatus } from '../src/runtime/permissions.js';
import type { MenuPermission, PermissionsNotice } from '../src/components/permissions/permissions.js';
import type { PermissionsItemProps } from '../src/components/topbar/items.js';

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

const [host, setHost] = createSignal<string | undefined>(undefined);
const [notice, setNotice] = createSignal<PermissionsNotice | undefined>('loading');
const [statuses, setStatuses] = createSignal<readonly PermissionStatus[] | undefined>(undefined);
const [hasGrants, setHasGrants] = createSignal(false);

/** What the panel asked of the page. */
export const permissionsAsked = {
  opens: 0,
  choices: fn<(name: EnforceablePermissionName, status: PermissionStatus) => void>(),
  resets: 0,
};

function write(next: readonly PermissionStatus[] | undefined): void {
  setStatuses(next);
  setHasGrants(next?.includes('granted') ?? false);
  flush();
}

/** The props a page gives the permissions button. */
export const storyPermissions: PermissionsItemProps = {
  permissions: STORY_PERMISSIONS,
  hasGrants,
  host,
  notice,
  statuses,
  onOpen: () => {
    permissionsAsked.opens += 1;
  },
  onChoose: (name, status) => {
    permissionsAsked.choices(name, status);
    const current = statuses();
    if (current !== undefined) {
      write(current.map((was, i) => (STORY_PERMISSIONS[i]?.name === name ? status : was)));
    }
  },
  onReset: () => {
    permissionsAsked.resets += 1;
    const current = statuses();
    if (current !== undefined) {
      write(current.map(() => 'ask'));
    }
    return Promise.resolve();
  },
};

/** A loaded app on `app.dot` whose statuses read as `granted` says, Ask for the rest. */
export function givenApp(granted: Partial<Record<EnforceablePermissionName, PermissionStatus>> = {}): void {
  setHost('app.dot');
  setNotice(undefined);
  write(STORY_PERMISSIONS.map(({ name }) => granted[name] ?? 'ask'));
}

/** No statuses to show, and why. The host stays while an app is loaded. */
export function givenNotice(next: PermissionsNotice, appHost?: string): void {
  setHost(appHost);
  setNotice(next);
  write(undefined);
}

/** The app's host as the page names it. */
export function givenHost(next: string): void {
  setHost(next);
  flush();
}

/** Every permission read as `status`, as a newer read lands. */
export function readAll(status: PermissionStatus): void {
  write(STORY_PERMISSIONS.map(() => status));
}

/** For a story's `beforeEach`: no app loaded yet, nothing asked. */
export function resetStoryPermissions(): void {
  givenNotice('loading');
  permissionsAsked.opens = 0;
  permissionsAsked.choices.mockClear();
  permissionsAsked.resets = 0;
}
