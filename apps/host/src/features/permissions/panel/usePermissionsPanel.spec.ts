// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createRoot, flush } from 'solid-js';
import { atom } from 'nanostores';
import { asProductId } from '@parity/truapi';
import type { ProductState } from '../../page/index.js';
import type { BrowserPermissionStatus } from '../policy/createBrowserPermissions.js';
import {
  PERMISSION_NAMES,
  type EnforceablePermissionName,
  type PermissionStatus,
  type PermissionTargets,
} from '../policy/permissionPolicy.js';
import type { ChangeOutcome, PendingPermissions } from '../policy/productPermissions.js';
import type { ProductPermissionsState } from '../policy/productPermissionsState.js';
import { usePermissionsPanel } from './usePermissionsPanel.js';

const LOADED: ProductState = {
  status: 'loaded',
  loadId: 1,
  label: 'app',
  productId: asProductId('app.dot'),
  facts: {},
};

/** The page's product and permissions, as boot left them, and the panel's props read from them under a fresh owner. */
function mount() {
  const product = atom<ProductState>({ status: 'none', loadId: 0 });
  const state = atom<ProductPermissionsState>({ status: 'none' });
  const pending = atom<PendingPermissions>(null);
  const intents = {
    refresh: vi.fn(() => Promise.resolve()),
    change: vi.fn((_label: string, _targets: PermissionTargets) => Promise.resolve<ChangeOutcome>({ failed: [] })),
  };
  // The browser blocks the camera only.
  const browser = {
    request: vi.fn(() => null),
    read: vi.fn((name: EnforceablePermissionName) =>
      Promise.resolve<BrowserPermissionStatus>(name === 'Camera' ? 'denied' : 'prompt'),
    ),
  };
  const { panel, dispose } = createRoot(d => ({
    panel: usePermissionsPanel({
      product,
      store: { state, pending, ...intents },
      browser,
    }),
    dispose: d,
  }));
  flush();
  const given = (shown: ProductState, read: ProductPermissionsState): void => {
    product.set(shown);
    state.set(read);
    flush();
  };
  return { panel, dispose, intents, given, pending, browser };
}

/** Every permission at Ask, with `changes` laid over them, in menu order. */
function statusesOf(changes: Partial<Record<EnforceablePermissionName, PermissionStatus>> = {}): PermissionStatus[] {
  return PERMISSION_NAMES.map(name => changes[name] ?? 'ask');
}

/** The statuses of `label`, read as `changes` over Ask. */
function read(
  changes: Partial<Record<EnforceablePermissionName, PermissionStatus>> = {},
  label = 'app',
): ProductPermissionsState {
  return { status: 'read', label, statuses: statusesOf(changes) };
}

describe('usePermissionsPanel', () => {
  it.each<[string, ProductState, ProductPermissionsState, string | undefined]>([
    ['the product is still loading', { status: 'none', loadId: 0 }, { status: 'none' }, 'loading'],
    ['there is no app', { status: 'error', loadId: 1 }, { status: 'none' }, 'no-app'],
    ['the permissions are unreadable', LOADED, { status: 'failed', label: 'app' }, 'unavailable'],
    ['the failure was for the app shown before', LOADED, { status: 'failed', label: 'other' }, undefined],
  ])('As the permissions panel, when %s, I say why there is nothing to change', (_case, shown, permissions, notice) => {
    // Given
    const { panel, dispose, given } = mount();

    // When
    given(shown, permissions);

    // Then
    expect(panel.notice()).toBe(notice);
    dispose();
  });

  it("As the permissions panel, I show the loaded app's statuses only once they are read for that app", () => {
    // Given
    const { panel, dispose, given } = mount();

    // When
    given(LOADED, { status: 'reading', label: 'app' });

    // Then
    expect(panel.statuses()).toBeUndefined();

    // When
    given(LOADED, read({ Camera: 'granted' }, 'other'));

    // Then
    expect(panel.statuses()).toBeUndefined();

    // When
    given(LOADED, read({ Camera: 'granted' }));

    // Then
    expect(panel.statuses()).toEqual(statusesOf({ Camera: 'granted' }));
    expect(panel.notice()).toBeUndefined();
    dispose();
  });

  it('As the permissions panel, opening asks for a fresh read', () => {
    // Given
    const { panel, dispose, intents } = mount();

    // When
    panel.onOpen();

    // Then
    expect(intents.refresh).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('As a user, a change applies to the app whose permissions were read and resolves what failed', async () => {
    // Given
    const { panel, dispose, intents, given } = mount();
    intents.change.mockResolvedValueOnce({ failed: ['Camera'] });
    given(LOADED, read());

    // When
    const failed = await panel.onChange({ Camera: 'granted' });

    // Then
    expect(intents.change).toHaveBeenCalledExactlyOnceWith('app', { Camera: 'granted' });
    expect(failed).toEqual(['Camera']);
    dispose();
  });

  it('As a user, I grant Notifications in the menu and the browser is asked inside my click', () => {
    // Given
    const { panel, dispose, given, browser } = mount();
    given(LOADED, read());

    // When
    void panel.onChange({ Notifications: 'granted' });

    // Then
    expect(browser.request).toHaveBeenCalledExactlyOnceWith('Notifications');
    dispose();
  });

  it('As a user, I deny a permission in the menu and the browser is not asked', () => {
    // Given
    const { panel, dispose, given, browser } = mount();
    given(LOADED, read());

    // When
    void panel.onChange({ Notifications: 'denied' });

    // Then
    expect(browser.request).not.toHaveBeenCalled();
    dispose();
  });

  it('As a user, I grant a permission while no permissions are read, and nothing is changed or asked of the browser', async () => {
    // Given
    const { panel, dispose, intents, given, browser } = mount();
    given(LOADED, { status: 'reading', label: 'app' });

    // When
    const failed = await panel.onChange({ Notifications: 'granted' });

    // Then
    expect(failed).toEqual([]);
    expect(intents.change).not.toHaveBeenCalled();
    expect(browser.request).not.toHaveBeenCalled();
    dispose();
  });

  it('As the permissions panel, a pending change shows its targets over the statuses read and marks the panel pending', () => {
    // Given
    const { panel, dispose, given, pending } = mount();
    given(LOADED, read({ ChainSubmit: 'denied' }));

    // When
    pending.set({ label: 'app', targets: { Camera: 'granted' } });
    flush();

    // Then
    expect(panel.statuses()).toEqual(statusesOf({ Camera: 'granted', ChainSubmit: 'denied' }));
    expect(panel.pending()).toBe(true);

    // When
    pending.set(null);
    flush();

    // Then
    expect(panel.statuses()).toEqual(statusesOf({ ChainSubmit: 'denied' }));
    expect(panel.pending()).toBe(false);
    dispose();
  });

  it('As the permissions panel, a pending change of the app shown before is not laid over this one', () => {
    // Given
    const { panel, dispose, given, pending } = mount();
    pending.set({ label: 'other', targets: { Camera: 'granted' } });

    // When
    given(LOADED, read());

    // Then
    expect(panel.statuses()).toEqual(statusesOf());
    expect(panel.pending()).toBe(false);
    dispose();
  });

  it('As the permissions panel, I open and say which browser-gated devices the browser itself blocks', async () => {
    // Given the browser blocks the camera
    const { panel, dispose, given } = mount();
    given(LOADED, read());

    // When
    panel.onOpen();
    await vi.waitFor(() => {
      flush();
      expect(panel.browserBlocked()).not.toHaveLength(0);
    });

    // Then
    expect(panel.browserBlocked()).toEqual(['Camera']);
    dispose();
  });
});
