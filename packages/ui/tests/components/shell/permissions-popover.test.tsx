// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush } from 'solid-js';
import type { PermissionAuthorizationRequest, PermissionAuthorizationStatus } from '@parity/truapi-host';
import { PermissionsPopover } from '../../../src/components/shell/PermissionsPopover.js';
import {
  ALL_PERMISSIONS,
  registerPermissionAuthorizationProvider,
  type PermissionStatus,
} from '../../../src/permissions.js';
import { setProductError, setProductLoaded } from '../../../src/state/product.js';
import { recordPermissionChange } from '../../../src/state/permissions.js';
import { setBlockingModalActive } from '../../../src/state/topbar.js';
import { pointerPressUnfocusable, renderComponent, resetStores, tabTo, waitForContent } from '../../helpers/solid.js';
import { renderTopbar, tapMoreRow } from './topbar-harness.js';
import { focusables } from '../../../src/components/focus.js';
import { byId, byTestId, must, query } from '../../support.js';
import { nth } from '../../helpers/nth.js';
import { stubPhoneViewport } from '../../helpers/viewport.js';

const LABEL = 'localhost:3000';

let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
  resetStores();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The permission a request asks about. */
function nameOf(request: PermissionAuthorizationRequest): string {
  switch (request.tag) {
    case 'Device':
      return request.value;
    case 'Remote':
      return request.value.permission.tag;
    case 'IdentityDisclosure':
    case 'AccountAccess':
      return request.tag;
  }
}

interface Provider {
  /** The stored statuses, by permission name ("NotDetermined" when absent). */
  stored: Map<string, PermissionAuthorizationStatus>;
  set: ReturnType<typeof vi.fn>;
}

/** A provider for `label` keeping statuses in memory, as the Rust core does. */
function provide(label = LABEL, initial: Record<string, PermissionAuthorizationStatus> = {}): Provider {
  const stored = new Map(Object.entries(initial));
  const set = vi.fn((request: PermissionAuthorizationRequest, status: PermissionAuthorizationStatus) => {
    stored.set(nameOf(request), status);
    return Promise.resolve();
  });
  cleanups.push(
    registerPermissionAuthorizationProvider(label, {
      getPermissionAuthorizationStatuses: requests =>
        Promise.resolve(requests.map(request => stored.get(nameOf(request)) ?? 'NotDetermined')),
      setPermissionAuthorizationStatus: set,
    }),
  );
  return { stored, set };
}

/** Records window events named `name` until the test ends. */
function recordEvents(name: string): unknown[] {
  const details: unknown[] = [];
  const listener = (event: Event): void => {
    details.push((event as CustomEvent).detail);
  };
  window.addEventListener(name, listener);
  cleanups.push(() => {
    window.removeEventListener(name, listener);
  });
  return details;
}

/** Let pending reads resolve and Solid apply what they wrote. */
async function settleAll(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    flush();
    await Promise.resolve();
  }
  flush();
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

async function renderPopover(): Promise<void> {
  renderComponent(() => (
    <div>
      <PermissionsPopover />
      <button id="outside" type="button">
        Outside
      </button>
    </div>
  ));
  await settleAll();
}

function isOpen(): boolean {
  return byId('permissions-popover').hasAttribute('data-open');
}

/** Open the popover, and wait for its body (its own chunk). */
async function openPopover(): Promise<void> {
  byId('permissions-button').click();
  await settleAll();
  expect(isOpen()).toBe(true);
  await waitForContent('permissions-popover');
  await settleAll();
}

/** The segment order in every row. */
const STATUSES: readonly PermissionStatus[] = ['ask', 'granted', 'denied'];

/** Each group's heading and its permissions, in menu order. */
const GROUPS: readonly { label: string; names: readonly string[] }[] = [
  {
    label: 'Device',
    names: ['Notifications', 'Camera', 'Microphone', 'Location', 'Bluetooth', 'NFC', 'Clipboard', 'Biometrics'],
  },
  { label: 'App', names: ['IdentityDisclosure', 'ChainSubmit', 'PreimageSubmit', 'StatementSubmit'] },
];

/** The row of permission `name`. */
function row(name: string): HTMLElement {
  return must(
    byId(`permissions-popover-name-${name}`).closest<HTMLElement>('[data-testid="permissions-popover-row"]'),
    `the ${name} row`,
  );
}

/** The segment that sets permission `name` to `status`. */
function segment(name: string, status: PermissionStatus): HTMLButtonElement {
  return byTestId(`permissions-popover-segment-${status}`, row(name), HTMLButtonElement);
}

/** The status whose segment is pressed in the row of permission `name`. */
function statusOf(name: string): PermissionStatus | undefined {
  return STATUSES.find(status => segment(name, status).getAttribute('aria-pressed') === 'true');
}

type PermissionsList =
  | { kind: 'empty' }
  | { kind: 'hint'; text: string }
  | {
      kind: 'rows';
      /** The app's host, on the head's chip. */
      host: string;
      /** Per permission name. A missing one is "ask". */
      statuses: Partial<Record<string, PermissionStatus>>;
    };

const tags = (el: Element): string[] => Array.from(el.children).map(child => child.tagName);

/** One permission row: icon, name, and the Ask, Allow and Deny segments with the current one pressed. */
function expectRow(el: Element, perm: (typeof ALL_PERMISSIONS)[number], status: PermissionStatus): void {
  expect(query(el, `#permissions-popover-name-${perm.name}`).textContent).toBe(perm.label);
  expect(el.querySelector('svg[aria-hidden="true"] path')).not.toBeNull();
  const group = query(el, '[role="group"]');
  expect(group.getAttribute('aria-label')).toBe(perm.label);
  const segments = Array.from(group.querySelectorAll('button'));
  expect(segments.map(button => button.textContent)).toEqual(['Ask', 'Allow', 'Deny']);
  expect(segments.map(button => button.type)).toEqual(['button', 'button', 'button']);
  expect(segments.map(button => button.dataset['testid'])).toEqual(
    STATUSES.map(each => `permissions-popover-segment-${each}`),
  );
  expect(segments.map(button => button.getAttribute('aria-pressed'))).toEqual(
    STATUSES.map(each => String(each === status)),
  );
}

/**
 * The popover: the shared Popover's surface, holding its head and list while
 * open, and nothing while closed.
 */
function expectPopover(opts: { open: boolean; list: PermissionsList }): void {
  const popover = byId('permissions-popover');
  expect(popover.getAttribute('role')).toBe('dialog');
  expect(popover.getAttribute('aria-label')).toBe('Permissions');
  expect(popover.getAttribute('tabindex')).toBe('-1');
  expect(popover.hasAttribute('data-open')).toBe(opts.open);
  const body = query(popover, ':scope > [data-testid="popover-body"]');
  if (!opts.open) {
    expect(body.childElementCount).toBe(0);
    return;
  }
  expect(query(byTestId('permissions-popover-header', body), 'h2').textContent).toBe('Permissions');
  const list = byId('permissions-popover-list');
  const { list: content } = opts;
  if (content.kind === 'empty') {
    expect(list.childElementCount).toBe(0);
    expect(body.querySelector('[data-testid="permissions-popover-foot"]')).toBeNull();
  } else if (content.kind === 'hint') {
    expect(tags(list)).toEqual(['DIV']);
    expect(byTestId('permissions-popover-hint', list).textContent).toBe(content.text);
    expect(body.querySelector('[data-testid="permissions-popover-foot"]')).toBeNull();
  } else {
    expect(byTestId('permissions-popover-host', body).textContent).toBe(content.host);
    const groups = Array.from(list.querySelectorAll('[data-testid="permissions-popover-group"]'));
    expect(groups.map(group => query(group, 'h3').textContent)).toEqual(GROUPS.map(({ label }) => label));
    groups.forEach((group, i) => {
      const { label, names } = nth(GROUPS, i);
      expect(group.getAttribute('role')).toBe('group');
      expect(byId(group.getAttribute('aria-labelledby') ?? '').textContent).toBe(label);
      const rows = Array.from(group.querySelectorAll('[data-testid="permissions-popover-row"]'));
      expect(rows).toHaveLength(names.length);
      names.forEach((name, j) => {
        const perm = must(
          ALL_PERMISSIONS.find(each => each.name === name),
          name,
        );
        expectRow(nth(rows, j), perm, content.statuses[name] ?? 'ask');
      });
    });
    expect(byTestId('permissions-popover-foot', body).textContent).toContain('Changes reload the app');
  }
}

/**
 * The button: its label, its icon and the ARIA of a popover trigger. Whether
 * it has its grants badge (`data-badge`) is left to the grants tests.
 */
function expectPermissionsButton(open: boolean): void {
  const button = byId('permissions-button');
  expect(button.getAttribute('title')).toBe('Permissions');
  expect(button.getAttribute('aria-label')).toBe('Permissions');
  expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  expect(button.getAttribute('aria-expanded')).toBe(String(open));
  expect(button.getAttribute('aria-controls')).toBe('permissions-popover');
  expect(tags(button)).toEqual(['svg']);
}

/** The backdrop: the shared Popover's, open with the popover. */
function expectBackdrop(open: boolean): void {
  const backdrop = byId('permissions-popover-backdrop');
  expect(backdrop.getAttribute('data-testid')).toBe('popover-backdrop');
  expect(backdrop.hasAttribute('data-open')).toBe(open);
}

describe('PermissionsPopover', () => {
  it('As a dotli user, the button, backdrop and closed popover have their ids, labels and ARIA state', async () => {
    // When
    await renderPopover();

    // Then
    expectPermissionsButton(false);
    expectBackdrop(false);
    expectPopover({ open: false, list: { kind: 'empty' } });
  });

  it('As a phone user, the permissions sheet leaves out its own heading and host, and lists every permission', async () => {
    // Given: a phone, where the popover opens as a sheet.
    stubPhoneViewport(true);
    provide(LABEL);
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(byId('permissions-popover').hasAttribute('data-sheet')).toBe(true);
    expect(document.querySelector('[data-testid="permissions-popover-header"]')).toBeNull();
    expect(document.querySelector('[data-testid="permissions-popover-host"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="permissions-popover-row"]')).toHaveLength(ALL_PERMISSIONS.length);
  });

  it("As a user of a loaded app, the popover lists its device and app permissions, each with its status pressed, under the app's host", async () => {
    // Given
    provide(LABEL, { Camera: 'Authorized', ChainSubmit: 'Denied' });
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(statusOf('Camera')).toBe('granted');
    expect(statusOf('ChainSubmit')).toBe('denied');
    expect(statusOf('Notifications')).toBe('ask');
    expectPopover({
      open: true,
      list: { kind: 'rows', host: 'app.dot', statuses: { Camera: 'granted', ChainSubmit: 'denied' } },
    });
    expectPermissionsButton(true);
    expect(byId('permissions-button').hasAttribute('data-badge')).toBe(true);
    expectBackdrop(true);
    expect(document.activeElement).toBe(byId('permissions-popover'));
  });

  it('As a user with no app loaded yet, or none on this domain, the popover says so', async () => {
    // Given
    await renderPopover();

    // When
    await openPopover();

    // Then
    expectPopover({
      open: true,
      list: {
        kind: 'hint',
        text: 'Wait for the app to finish loading to change its permissions.',
      },
    });

    // When
    setProductError();
    await settleAll();

    // Then
    expectPopover({
      open: true,
      list: { kind: 'hint', text: 'No app is loaded on this domain.' },
    });
  });

  it("As a user whose app's permissions cannot be read, the popover says they are unavailable", async () => {
    // Given
    cleanups.push(
      registerPermissionAuthorizationProvider(LABEL, {
        getPermissionAuthorizationStatuses: () => Promise.reject(new Error('core down')),
        setPermissionAuthorizationStatus: async () => {},
      }),
    );
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();

    // When
    await openPopover();

    // Then
    expectPopover({
      open: true,
      list: {
        kind: 'hint',
        text: 'Permissions are unavailable for this app.',
      },
    });
    expect(byId('permissions-button').hasAttribute('data-badge')).toBe(false);
  });

  it('As a user, allowing a permission stores it and announces { label, permission }; a device permission announces a device change', async () => {
    // Given
    const provider = provide(LABEL, { Camera: 'Authorized' });
    const grants = recordEvents('dotli:permission-changed');
    const devices = recordEvents('dotli:device-permission-changed');
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();

    // When
    segment('Notifications', 'granted').click();
    await settleAll();

    // Then
    expect(provider.set).toHaveBeenCalledWith({ tag: 'Device', value: 'Notifications' }, 'Authorized');
    expect(grants).toEqual([{ label: LABEL, permission: 'Notifications' }]);
    expect(devices).toEqual([]);
    expect(statusOf('Notifications')).toBe('granted');
    expect(isOpen()).toBe(true);

    // When: back to Ask resets it.
    segment('Camera', 'ask').click();
    await settleAll();

    // Then
    expect(provider.set).toHaveBeenLastCalledWith({ tag: 'Device', value: 'Camera' }, 'NotDetermined');
    expect(devices).toEqual([{ label: LABEL, permission: 'Camera' }]);
    expect(statusOf('Camera')).toBe('ask');
  });

  it('As a user, pressing the status a permission already has writes nothing and reloads nothing', async () => {
    // Given
    const provider = provide(LABEL, { Camera: 'Authorized' });
    const grants = recordEvents('dotli:permission-changed');
    const devices = recordEvents('dotli:device-permission-changed');
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();

    // When
    segment('Camera', 'granted').click();
    await settleAll();

    // Then
    expect(provider.set).not.toHaveBeenCalled();
    expect(grants).toEqual([]);
    expect(devices).toEqual([]);
    expect(statusOf('Camera')).toBe('granted');
  });

  it('As a user, a change that fails re-reads the statuses while the popover is open, and not once it is closed', async () => {
    // Given: every change waits until the test fails it; reads are counted.
    const changes: ((err: Error) => void)[] = [];
    let reads = 0;
    cleanups.push(
      registerPermissionAuthorizationProvider(LABEL, {
        getPermissionAuthorizationStatuses: requests => {
          reads += 1;
          return Promise.resolve(requests.map(() => 'NotDetermined' as const));
        },
        setPermissionAuthorizationStatus: () =>
          new Promise((_resolve, reject) => {
            changes.push(reject);
          }),
      }),
    );
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();
    segment('Notifications', 'granted').click();
    await settleAll();
    const beforeFailure = reads;

    // When: the change fails while the popover is open.
    nth(changes, 0)(new Error('core down'));
    await settleAll();

    // Then
    expect(reads).toBe(beforeFailure + 1);

    // When: another change fails after the popover closed.
    segment('Notifications', 'denied').click();
    await settleAll();
    byId('permissions-button').click();
    await settleAll();
    expect(isOpen()).toBe(false);
    const afterClose = reads;
    nth(changes, 1)(new Error('core down'));
    await settleAll();

    // Then: nothing is read until the next open.
    expect(reads).toBe(afterClose);
  });

  it('As a keyboard user, choosing a status keeps my focus on the segment I pressed', async () => {
    // Given
    provide();
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();
    segment('Camera', 'granted').focus();

    // When
    segment('Camera', 'granted').click();
    await settleAll();

    // Then
    expect(statusOf('Camera')).toBe('granted');
    expect(document.activeElement).toBe(segment('Camera', 'granted'));
  });

  it("As a screen-reader user, each permission's segments are a group named after it, inside a named Device or App group, and each segment says whether it is pressed", async () => {
    // Given
    provide(LABEL, { Camera: 'Denied' });
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(query(row('Camera'), '[role="group"]').getAttribute('aria-label')).toBe('Camera');
    expect(segment('Camera', 'denied').getAttribute('aria-pressed')).toBe('true');
    expect(segment('Camera', 'ask').getAttribute('aria-pressed')).toBe('false');
    const device = must(row('Camera').closest('[data-testid="permissions-popover-group"]'), 'the Device group');
    expect(byId(device.getAttribute('aria-labelledby') ?? '').textContent).toBe('Device');
    const app = must(row('ChainSubmit').closest('[data-testid="permissions-popover-group"]'), 'the App group');
    expect(byId(app.getAttribute('aria-labelledby') ?? '').textContent).toBe('App');
  });

  it('As a keyboard user, Escape on a segment closes the popover at once and hands focus back to the button', async () => {
    // Given
    provide();
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    byId('permissions-button').focus();
    await openPopover();
    segment('Camera', 'granted').focus();

    // When
    press('Escape');
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);
    expect(byId('permissions-button').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(byId('permissions-button'));
  });

  it('As a screen-reader user, the button announces the dialog it opens and whether it is open', async () => {
    // Given
    provide();
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    const button = byId('permissions-button');
    const popover = byId('permissions-popover');

    // Then
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Permissions');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-controls')).toBe('permissions-popover');
    expect(button.getAttribute('aria-expanded')).toBe('false');

    // When
    await openPopover();

    // Then
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('As a keyboard user, opening it moves focus in, and Tab past the last control loops back to the first', async () => {
    // Given
    provide();
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    byId('permissions-button').focus();

    // When
    await openPopover();

    // Then
    expect(byId('permissions-popover').contains(document.activeElement)).toBe(true);

    // Given
    const controls = focusables(byId('permissions-popover'));
    // One Tab stop per row: its other segments are reached with the arrow keys.
    expect(controls.filter(el => el.closest('[data-testid="permissions-popover-row"]'))).toHaveLength(
      ALL_PERMISSIONS.length,
    );
    nth(controls, controls.length - 1).focus();
    await settleAll();
    expect(isOpen()).toBe(true);

    // When
    const tab = tabTo(byId('outside'));
    await settleAll();

    // Then
    expect(tab.defaultPrevented).toBe(true);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(focusables(byId('permissions-popover'))[0]);
  });

  it('As a user, a press on the backdrop closes the popover without handing focus back to the button', async () => {
    // Given
    provide();
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    byId('permissions-button').focus();
    await openPopover();

    // When: the backdrop covers the page, and takes no focus.
    pointerPressUnfocusable(byId('permissions-popover-backdrop'));
    await settleAll();

    // Then: focus follows the press.
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('As a user, the button toggles the popover, and a blocking modal coming up closes it', async () => {
    // Given
    provide();
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();

    // When
    byId('permissions-button').click();
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);

    // When
    await openPopover();
    setBlockingModalActive(true);
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);
  });

  it('As a user, the lock button shows its grants badge while the app has any permission granted, including an app loaded before the island mounted', async () => {
    // Given
    const provider = provide(LABEL, { ChainSubmit: 'Authorized' });
    setProductLoaded(LABEL, 'app.dot');

    // When
    await renderPopover();

    // Then
    expect(byId('permissions-button').hasAttribute('data-badge')).toBe(true);

    // When
    provider.stored.clear();
    recordPermissionChange({
      kind: 'grant',
      label: LABEL,
      permission: 'ChainSubmit',
    });
    await settleAll();

    // Then
    expect(byId('permissions-button').hasAttribute('data-badge')).toBe(false);

    // When
    provider.stored.set('Camera', 'Authorized');
    recordPermissionChange({
      kind: 'device',
      label: LABEL,
      permission: 'Camera',
    });
    await settleAll();

    // Then
    expect(byId('permissions-button').hasAttribute('data-badge')).toBe(true);

    // When
    setProductError();
    await settleAll();

    // Then
    expect(byId('permissions-button').hasAttribute('data-badge')).toBe(false);
  });

  it('As a user, when reads overlap, the last one wins: a slow earlier read never replaces a newer one', async () => {
    // Given: every read waits until the test answers it.
    const reads: {
      resolve: (statuses: PermissionAuthorizationStatus[]) => void;
      count: number;
    }[] = [];
    cleanups.push(
      registerPermissionAuthorizationProvider(LABEL, {
        getPermissionAuthorizationStatuses: requests =>
          new Promise(resolve => {
            reads.push({ resolve, count: requests.length });
          }),
        setPermissionAuthorizationStatus: async () => {},
      }),
    );
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    const all = (status: PermissionAuthorizationStatus) => ALL_PERMISSIONS.map(() => status);

    // When: opening reads (after the mount's grants read), then a
    // permission change reads again, for the badge and for the list.
    await openPopover();
    const beforeChange = reads.length;
    window.dispatchEvent(
      new CustomEvent('dotli:permission-changed', {
        detail: { label: LABEL, permission: 'Camera' },
      }),
    );
    await settleAll();
    const newer = reads.slice(beforeChange);
    const older = reads.slice(0, beforeChange);
    expect(older.length).toBeGreaterThanOrEqual(2);
    expect(newer).toHaveLength(2);
    for (const read of newer) {
      read.resolve(all('Denied'));
    }
    await settleAll();
    for (const read of older) {
      read.resolve(all('Authorized'));
    }
    await settleAll();

    // Then
    expect(statusOf('Camera')).toBe('denied');
    expect(byId('permissions-button').hasAttribute('data-badge')).toBe(false);
  });

  it('As a user who closed the popover while it was reading, the next open never shows that read', async () => {
    // Given: every read waits until the test answers it.
    const reads: ((statuses: PermissionAuthorizationStatus[]) => void)[] = [];
    cleanups.push(
      registerPermissionAuthorizationProvider(LABEL, {
        getPermissionAuthorizationStatuses: () =>
          new Promise(resolve => {
            reads.push(resolve);
          }),
        setPermissionAuthorizationStatus: async () => {},
      }),
    );
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    const all = (status: PermissionAuthorizationStatus) => ALL_PERMISSIONS.map(() => status);
    const answer = async (status: PermissionAuthorizationStatus) => {
      for (const resolve of reads.splice(0)) {
        resolve(all(status));
      }
      await settleAll();
    };
    await answer('Denied');

    // When: opened, closed before the read answers, the read answers, and
    // the popover opens again.
    await openPopover();
    byId('permissions-button').click();
    await settleAll();
    await answer('Authorized');
    await openPopover();

    // Then: nothing until the new read answers, then its statuses.
    expect(document.querySelectorAll('[data-testid="permissions-popover-row"]')).toHaveLength(0);
    await answer('Denied');
    expect(statusOf('Camera')).toBe('denied');
  });

  it("As a user, when the app changes while the popover is open, the previous app's statuses are never shown for it", async () => {
    // Given
    provide(LABEL, { Camera: 'Authorized' });
    provide('other.dot');
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();
    expect(statusOf('Camera')).toBe('granted');

    // When
    setProductLoaded('other.dot', 'other.dot');
    flush();

    // Then: nothing until the new app's read lands, then its statuses.
    expect(document.querySelectorAll('[data-testid="permissions-popover-row"]')).toHaveLength(0);
    await settleAll();
    expect(statusOf('Camera')).toBe('ask');
  });

  it('As a user of an app whose label contains markup, it is only ever passed on as text', async () => {
    // Given
    const label = '<img id="injected" src="x">';
    const provider = provide(label);
    const grants = recordEvents('dotli:permission-changed');
    setProductLoaded(label, 'app.dot');
    await renderPopover();

    // When
    await openPopover();
    segment('Notifications', 'granted').click();
    await settleAll();

    // Then
    expect(document.getElementById('injected')).toBeNull();
    expect(byId('permissions-popover').querySelector('img')).toBeNull();
    expect(provider.set).toHaveBeenCalledTimes(1);
    expect(grants).toEqual([{ label, permission: 'Notifications' }]);
  });

  it("As a mobile user, the More menu's Permissions row opens the popover", async () => {
    // Given: the bar has collapsed the permissions button into the More menu.
    provide();
    setProductLoaded(LABEL, 'app.dot');
    await renderTopbar(() => <PermissionsPopover />, 1);

    // When
    await tapMoreRow('permissions');
    await settleAll();

    // Then
    expect(byId('more-popover').hasAttribute('data-open')).toBe(false);
    expect(isOpen()).toBe(true);
    expect(document.querySelectorAll('[data-testid="permissions-popover-row"]')).toHaveLength(ALL_PERMISSIONS.length);
  });

  it('As a user, Reset all to Ask sets every permission of the app back to Ask, and the app reloads once', async () => {
    // Given
    const provider = provide(LABEL, { Camera: 'Authorized', Microphone: 'Denied', ChainSubmit: 'Authorized' });
    const grants = recordEvents('dotli:permission-changed');
    const devices = recordEvents('dotli:device-permission-changed');
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();

    // When
    byTestId('permissions-popover-reset').click();
    await settleAll();

    // Then
    expect(provider.set).toHaveBeenCalledTimes(3);
    expect(provider.set).toHaveBeenCalledWith({ tag: 'Device', value: 'Camera' }, 'NotDetermined');
    expect(provider.set).toHaveBeenCalledWith({ tag: 'Device', value: 'Microphone' }, 'NotDetermined');
    expect(provider.set).toHaveBeenCalledWith(
      { tag: 'Remote', value: { permission: { tag: 'ChainSubmit' } } },
      'NotDetermined',
    );
    expect(devices).toEqual([{ label: LABEL, permission: 'Camera' }]);
    expect(grants).toEqual([]);
    expectPopover({ open: true, list: { kind: 'rows', host: 'app.dot', statuses: {} } });
    expect(byTestId('permissions-popover-reset', document, HTMLButtonElement).disabled).toBe(true);
    expect(byId('permissions-button').hasAttribute('data-badge')).toBe(false);
  });

  it('As a user whose app has only permissions the iframe does not gate decided, Reset all to Ask applies them without a reload', async () => {
    // Given
    provide(LABEL, { Notifications: 'Authorized', ChainSubmit: 'Denied' });
    const grants = recordEvents('dotli:permission-changed');
    const devices = recordEvents('dotli:device-permission-changed');
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();

    // When
    byTestId('permissions-popover-reset').click();
    await settleAll();

    // Then
    expect(grants).toEqual([{ label: LABEL, permission: 'Notifications' }]);
    expect(devices).toEqual([]);
    expect(statusOf('Notifications')).toBe('ask');
    expect(statusOf('ChainSubmit')).toBe('ask');
  });

  it('As a user with nothing granted or denied, Reset all to Ask is disabled and writes nothing', async () => {
    // Given
    const provider = provide(LABEL);
    const grants = recordEvents('dotli:permission-changed');
    const devices = recordEvents('dotli:device-permission-changed');
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();
    const reset = byTestId('permissions-popover-reset', document, HTMLButtonElement);

    // When
    reset.click();
    await settleAll();

    // Then
    expect(reset.textContent).toBe('Reset all to Ask');
    expect(reset.disabled).toBe(true);
    expect(provider.set).not.toHaveBeenCalled();
    expect(grants).toEqual([]);
    expect(devices).toEqual([]);
  });

  it('As a user pressing Reset all to Ask again while it runs, the app reloads once', async () => {
    // Given: every write waits until the test lets it through.
    const stored = new Map<string, PermissionAuthorizationStatus>([['Camera', 'Authorized']]);
    const releases: (() => void)[] = [];
    const set = vi.fn(
      (request: PermissionAuthorizationRequest, status: PermissionAuthorizationStatus) =>
        new Promise<void>(resolve => {
          releases.push(() => {
            stored.set(nameOf(request), status);
            resolve();
          });
        }),
    );
    cleanups.push(
      registerPermissionAuthorizationProvider(LABEL, {
        getPermissionAuthorizationStatuses: requests =>
          Promise.resolve(requests.map(request => stored.get(nameOf(request)) ?? 'NotDetermined')),
        setPermissionAuthorizationStatus: set,
      }),
    );
    const devices = recordEvents('dotli:device-permission-changed');
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();

    // When
    byTestId('permissions-popover-reset').click();
    await settleAll();
    byTestId('permissions-popover-reset').click();
    await settleAll();
    for (const release of releases.splice(0)) {
      release();
    }
    await settleAll();

    // Then
    expect(set).toHaveBeenCalledTimes(1);
    expect(devices).toEqual([{ label: LABEL, permission: 'Camera' }]);
    expect(statusOf('Camera')).toBe('ask');
  });

  it('As a user, a reset that cannot change one permission still reloads once for the others, and shows the one that stayed', async () => {
    // Given: the core refuses to change the camera.
    const stored = new Map<string, PermissionAuthorizationStatus>([
      ['Camera', 'Authorized'],
      ['Microphone', 'Authorized'],
    ]);
    cleanups.push(
      registerPermissionAuthorizationProvider(LABEL, {
        getPermissionAuthorizationStatuses: requests =>
          Promise.resolve(requests.map(request => stored.get(nameOf(request)) ?? 'NotDetermined')),
        setPermissionAuthorizationStatus: (request, status) => {
          if (nameOf(request) === 'Camera') {
            return Promise.reject(new Error('core down'));
          }
          stored.set(nameOf(request), status);
          return Promise.resolve();
        },
      }),
    );
    const devices = recordEvents('dotli:device-permission-changed');
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();

    // When
    byTestId('permissions-popover-reset').click();
    await settleAll();

    // Then
    expect(devices).toEqual([{ label: LABEL, permission: 'Microphone' }]);
    expect(statusOf('Camera')).toBe('granted');
    expect(statusOf('Microphone')).toBe('ask');
    expect(byTestId('permissions-popover-reset', document, HTMLButtonElement).disabled).toBe(false);
  });

  it('As a keyboard user, Reset all to Ask leaves my focus in the popover once the button has nothing left to reset', async () => {
    // Given
    provide(LABEL, { Camera: 'Authorized' });
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();
    const reset = byTestId('permissions-popover-reset', document, HTMLButtonElement);
    reset.focus();

    // When
    reset.click();

    // Then: the hand-off is at once, as a real browser drops the focus of a button that gets disabled.
    expect(document.activeElement).toBe(byId('permissions-popover'));

    // When
    await settleAll();

    // Then
    expect(reset.disabled).toBe(true);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(byId('permissions-popover'));
  });
});
