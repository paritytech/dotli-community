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
import { setAuthState } from '../../../src/state/auth.js';
import { renderComponent, resetStores, waitForContent } from '../../helpers/solid.js';
import { renderTopbar, tapMoreRow } from './topbar-harness.js';
import { byId, byTestId, must, query } from '../../support.js';
import { nth } from '../../helpers/nth.js';
import { stubPhoneViewport } from '../../helpers/viewport.js';
import { useFloatingSurfaces } from '../../helpers/floating.js';

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
    case 'ChatAuthority':
    case 'StatementStoreAllowance':
    case 'ProfileDisclosure':
    case 'Calling':
    case 'AutomaticPreimageSubmit':
      return request.tag;
  }
}

interface Provider {
  /** The stored statuses, by permission name ("NotDetermined" when absent). */
  stored: Map<string, PermissionAuthorizationStatus>;
  set: ReturnType<
    typeof vi.fn<(request: PermissionAuthorizationRequest, status: PermissionAuthorizationStatus) => Promise<void>>
  >;
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

/**
 * Let pending reads resolve and Solid apply what they wrote. A read joins the
 * statuses with the host Media Calling settings, a few microtasks deeper.
 */
async function settleAll(): Promise<void> {
  for (let i = 0; i < 16; i += 1) {
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

useFloatingSurfaces();

describe('PermissionsPopover', () => {
  it('offers the same permission controls on phones', async () => {
    stubPhoneViewport(true);
    const provider = provide();
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();
    segment('Camera', 'granted').click();
    await settleAll();
    expect(provider.stored.get('Camera')).toBe('Authorized');
    expect(statusOf('Camera')).toBe('granted');
  });

  it('lists stored statuses and hides automatic consent without an account', async () => {
    provide(LABEL, { Camera: 'Authorized', ChainSubmit: 'Denied' });
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();

    expect(statusOf('Camera')).toBe('granted');
    expect(statusOf('ChainSubmit')).toBe('denied');
    expect(statusOf('Notifications')).toBe('ask');
    expect(document.getElementById('permissions-popover-name-AutomaticPreimageSubmit')).toBeNull();
    expect(byId('permissions-button').hasAttribute('data-badge')).toBe(true);
    expect(document.activeElement).toBe(byId('permissions-popover'));
  });

  it('As a user whose permission read fails, no stale statuses or grants are shown', async () => {
    cleanups.push(
      registerPermissionAuthorizationProvider(LABEL, {
        getPermissionAuthorizationStatuses: () => Promise.reject(new Error('core down')),
        setPermissionAuthorizationStatus: async () => {},
      }),
    );
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();

    expect(document.querySelectorAll('[data-testid="permissions-popover-row"]')).toHaveLength(0);
    expect(byTestId('permissions-popover-hint').textContent).toContain('unavailable');
    expect(byId('permissions-button').hasAttribute('data-badge')).toBe(false);
  });

  it('stores and announces changes without duplicating the core-owned device refresh', async () => {
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
    segment('Camera', 'ask').click();
    await settleAll();

    // Then
    expect(provider.set).toHaveBeenLastCalledWith({ tag: 'Device', value: 'Camera' }, 'NotDetermined');
    expect(grants).toEqual([
      { label: LABEL, permission: 'Notifications' },
      { label: LABEL, permission: 'Camera' },
    ]);
    expect(devices).toEqual([]);
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
    press('Escape');
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
    expect(byId(app.getAttribute('aria-labelledby') ?? '').textContent).toBe('Account and chain');
  });

  it('As a screen-reader user, the button announces the dialog it opens and whether it is open', async () => {
    // Given
    provide();
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    const button = byId('permissions-button');

    // Then
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-controls')).toBe('permissions-popover');
    expect(button.getAttribute('aria-expanded')).toBe('false');

    // When
    await openPopover();

    // Then
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const popover = byId('permissions-popover');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Permissions');
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

  it('keeps all automatic upload choices inline and keyboard reachable on phones', async () => {
    stubPhoneViewport(true);
    setAuthState({ tag: 'Connected', session: { connected: true, publicKey: `0x${'01'.repeat(32)}` } });
    const provider = provide();
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();
    const ask = segment('AutomaticPreimageSubmit', 'ask');
    const allow = segment('AutomaticPreimageSubmit', 'granted');
    const revoke = segment('AutomaticPreimageSubmit', 'denied');
    expect(ask.tabIndex).toBe(0);
    expect(row('AutomaticPreimageSubmit').querySelector('[aria-haspopup]')).toBeNull();
    ask.focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(allow);
    press('ArrowDown');
    expect(document.activeElement).toBe(revoke);
    expect(provider.set).not.toHaveBeenCalled();
    revoke.click();
    await settleAll();
    expect(statusOf('AutomaticPreimageSubmit')).toBe('denied');
    expect(isOpen()).toBe(true);
  });

  it.each(['ask', 'denied'] as const)('revokes only automatic consent with %s', async choice => {
    setAuthState({ tag: 'Connected', session: { connected: true, publicKey: `0x${'01'.repeat(32)}` } });
    const provider = provide(LABEL, { PreimageSubmit: 'Authorized' });
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();
    segment('AutomaticPreimageSubmit', 'granted').click();
    await settleAll();
    expect(statusOf('AutomaticPreimageSubmit')).toBe('granted');
    expect(isOpen()).toBe(true);
    segment('AutomaticPreimageSubmit', choice).click();
    await settleAll();
    expect(statusOf('AutomaticPreimageSubmit')).toBe(choice);
    expect(isOpen()).toBe(true);
    expect(statusOf('PreimageSubmit')).toBe('granted');
    expect(provider.set).toHaveBeenCalledWith(
      { tag: 'AutomaticPreimageSubmit', value: { rootPublicKey: `0x${'01'.repeat(32)}` } },
      choice === 'ask' ? 'NotDetermined' : 'Denied',
    );
  });

  it('discards old-account reads and rejects a stale inline action before reactive cleanup', async () => {
    const rootA = `0x${'01'.repeat(32)}`;
    const rootB = `0x${'02'.repeat(32)}`;
    setAuthState({ tag: 'Connected', session: { connected: true, publicKey: rootA } });
    const provider = provide(LABEL, { AutomaticPreimageSubmit: 'Authorized' });
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();
    const reads: { resolve: (statuses: PermissionAuthorizationStatus[]) => void; count: number }[] = [];
    cleanups.push(
      registerPermissionAuthorizationProvider(LABEL, {
        getPermissionAuthorizationStatuses: requests => {
          const { promise, resolve } = Promise.withResolvers<PermissionAuthorizationStatus[]>();
          reads.push({ resolve, count: requests.length });
          return promise;
        },
        setPermissionAuthorizationStatus: provider.set,
      }),
    );
    recordPermissionChange({ kind: 'grant', label: LABEL, permission: 'AutomaticPreimageSubmit' });
    await settleAll();
    const oldReads = reads.splice(0);
    const staleChoice = segment('AutomaticPreimageSubmit', 'denied');
    setAuthState({ tag: 'Connected', session: { connected: true, publicKey: rootB } });
    staleChoice.click();
    expect(provider.set).not.toHaveBeenCalled();
    await settleAll();
    expect(document.getElementById('permissions-popover-name-AutomaticPreimageSubmit')).toBeNull();
    expect(byId('permissions-button').hasAttribute('data-badge')).toBe(false);
    for (const read of reads.splice(0)) {
      read.resolve(Array.from({ length: read.count }, () => 'NotDetermined'));
    }
    await settleAll();
    for (const read of oldReads) {
      read.resolve(Array.from({ length: read.count }, () => 'Authorized'));
    }
    await settleAll();
    expect(statusOf('AutomaticPreimageSubmit')).toBe('ask');
    expect(byId('permissions-button').hasAttribute('data-badge')).toBe(false);
    setAuthState({ tag: 'Disconnected' });
    await settleAll();
    for (const read of reads.splice(0)) {
      read.resolve(Array.from({ length: read.count }, () => 'NotDetermined'));
    }
    await settleAll();
    expect(document.getElementById('permissions-popover-name-AutomaticPreimageSubmit')).toBeNull();
  });

  it('associates bounded-consent limits with the automatic upload control', async () => {
    setAuthState({ tag: 'Connected', session: { connected: true, publicKey: `0x${'01'.repeat(32)}` } });
    provide();
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();
    const control = byId('permissions-popover-automatic-AutomaticPreimageSubmit');
    expect(control.tagName).toBe('FIELDSET');
    expect(byId(control.getAttribute('aria-labelledby') ?? '').textContent).toBe(
      ALL_PERMISSIONS.find(permission => permission.name === 'AutomaticPreimageSubmit')?.label,
    );
    expect(segment('AutomaticPreimageSubmit', 'ask').textContent).toBe('Ask per upload');
    expect(segment('AutomaticPreimageSubmit', 'granted').textContent).toBe('Allow bounded uploads');
    expect(segment('AutomaticPreimageSubmit', 'denied').textContent).toBe('Revoke automatic uploads');
    const description = byId(control.getAttribute('aria-describedby') ?? '');
    expect(description.textContent).toContain('256 KiB');
    expect(description.textContent).toContain('4 automatic uploads per rolling hour');
    expect(description.textContent).toContain('Regranting does not reset the budget');
    const group = must(control.closest('[data-testid="permissions-popover-group"]'), 'account permissions');
    expect(byId(group.getAttribute('aria-labelledby') ?? '').textContent).toBe('Account and chain');
  });

  it('keeps stored automatic consent while pending, rejects duplicate writes, and allows retry after failure', async () => {
    setAuthState({ tag: 'Connected', session: { connected: true, publicKey: `0x${'01'.repeat(32)}` } });
    const provider = provide();
    const write = Promise.withResolvers<undefined>();
    provider.set.mockImplementationOnce(() => write.promise);
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();
    const control = byId('permissions-popover-automatic-AutomaticPreimageSubmit');
    const allow = segment('AutomaticPreimageSubmit', 'granted');
    allow.focus();
    allow.click();
    await settleAll();
    expect(control.getAttribute('aria-busy')).toBe('true');
    expect(statusOf('AutomaticPreimageSubmit')).toBe('ask');
    expect(segment('AutomaticPreimageSubmit', 'granted')).toBe(allow);
    expect(document.activeElement).toBe(allow);
    expect(isOpen()).toBe(true);
    allow.click();
    await settleAll();
    expect(provider.set).toHaveBeenCalledTimes(1);
    write.reject(new Error('core down'));
    await settleAll();
    expect(control.getAttribute('aria-busy')).toBe('false');
    expect(segment('AutomaticPreimageSubmit', 'granted')).toBe(allow);
    expect(document.activeElement).toBe(allow);
    expect(isOpen()).toBe(true);
    expect(row('AutomaticPreimageSubmit').querySelector('[role="alert"]')).not.toBeNull();
    expect(provider.stored.has('AutomaticPreimageSubmit')).toBe(false);
    allow.click();
    await settleAll();
    expect(provider.stored.get('AutomaticPreimageSubmit')).toBe('Authorized');
    expect(row('AutomaticPreimageSubmit').querySelector('[role="alert"]')).toBeNull();
    expect(statusOf('AutomaticPreimageSubmit')).toBe('granted');
    expect(isOpen()).toBe(true);
  });

  it('rejects a stale reset click before an account switch is rendered', async () => {
    setAuthState({ tag: 'Connected', session: { connected: true, publicKey: `0x${'01'.repeat(32)}` } });
    const provider = provide(LABEL, { AutomaticPreimageSubmit: 'Authorized' });
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();
    const reset = byTestId('permissions-popover-reset', document, HTMLButtonElement);
    setAuthState({ tag: 'Connected', session: { connected: true, publicKey: `0x${'02'.repeat(32)}` } });
    reset.click();
    await settleAll();
    expect(provider.set).not.toHaveBeenCalled();
  });

  it('switches raw capture to protected Media without changing permission grants', async () => {
    const provider = provide();
    const switches = recordEvents('dotli:capture-container-changed');
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();
    byTestId('permissions-popover-media-container').click();
    await settleAll();
    expect(switches).toEqual([{ label: LABEL, legacyCapture: false }]);
    expect(provider.set).not.toHaveBeenCalled();
    expect(isOpen()).toBe(false);
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
    press('Escape');
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
    expect(document.querySelectorAll('[data-testid="permissions-popover-row"]')).toHaveLength(
      ALL_PERMISSIONS.length - 1,
    );
  });

  it('As a user, Reset all to Ask sets every permission of the app back to Ask, announced as one change', async () => {
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
    expect(grants).toEqual([{ label: LABEL, permission: 'Camera' }]);
    expect(devices).toEqual([]);
    expect(statusOf('Camera')).toBe('ask');
    expect(statusOf('Microphone')).toBe('ask');
    expect(statusOf('ChainSubmit')).toBe('ask');
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
    expect(reset.disabled).toBe(true);
    expect(provider.set).not.toHaveBeenCalled();
    expect(grants).toEqual([]);
    expect(devices).toEqual([]);
  });

  it('As a user pressing Reset all to Ask again while it runs, the change is announced once', async () => {
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
    const grants = recordEvents('dotli:permission-changed');
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
    expect(grants).toEqual([{ label: LABEL, permission: 'Camera' }]);
    expect(statusOf('Camera')).toBe('ask');
  });

  it('As a user, a reset that cannot change one permission still announces the others once, and shows the one that stayed', async () => {
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
    const grants = recordEvents('dotli:permission-changed');
    setProductLoaded(LABEL, 'app.dot');
    await renderPopover();
    await openPopover();

    // When
    byTestId('permissions-popover-reset').click();
    await settleAll();

    // Then
    expect(grants).toEqual([{ label: LABEL, permission: 'Microphone' }]);
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
