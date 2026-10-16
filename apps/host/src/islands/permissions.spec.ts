// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createRoot, flush } from 'solid-js';
import { createSyncStore } from '@dotli/shared';
import type { PermissionStatus, PermissionTargets } from '../runtime/permissions.js';
import type { ChangeOutcome, PendingPermissions } from '../runtime/state/product-permissions.js';
import type { MenuPermission } from '../components/permissions/permissions.js';
import { type ReadPermissions, type ShownProduct, usePermissionsPanel } from './permissions.js';

const PERMISSIONS: readonly MenuPermission[] = [
  { name: 'Camera', label: 'Camera', group: 'device' },
  { name: 'ChainSubmit', label: 'Sign transactions', group: 'app' },
];

const LOADED: ShownProduct = { status: 'loaded', label: 'app' };

/** The page's product and permissions, as boot left them, and the panel's props read from them under a fresh owner. */
function mount() {
  const product = createSyncStore<ShownProduct>('permissions-test-product', { status: 'none' });
  const state = createSyncStore<ReadPermissions>('permissions-test-state', { status: 'none' });
  const pending = createSyncStore<PendingPermissions>('permissions-test-pending', null);
  const intents = {
    refresh: vi.fn(() => Promise.resolve()),
    change: vi.fn((_label: string, _targets: PermissionTargets) => Promise.resolve<ChangeOutcome>({ failed: [] })),
  };
  const { panel, dispose } = createRoot(d => ({
    panel: usePermissionsPanel({ permissions: PERMISSIONS, product, state, pending, ...intents }),
    dispose: d,
  }));
  flush();
  const given = (shown: ShownProduct, read: ReadPermissions): void => {
    product.set(shown);
    state.set(read);
    flush();
  };
  return { panel, dispose, intents, given, pending };
}

const read = (statuses: readonly PermissionStatus[], label = 'app'): ReadPermissions => ({
  status: 'read',
  label,
  statuses,
});

describe('usePermissionsPanel', () => {
  it.each<[string, ShownProduct, ReadPermissions, string | undefined]>([
    ['the product is still loading', { status: 'none' }, { status: 'none' }, 'loading'],
    ['there is no app', { status: 'error' }, { status: 'none' }, 'no-app'],
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
    given(LOADED, read(['granted', 'ask'], 'other'));

    // Then
    expect(panel.statuses()).toBeUndefined();

    // When
    given(LOADED, read(['granted', 'ask']));

    // Then
    expect(panel.statuses()).toEqual(['granted', 'ask']);
    expect(panel.notice()).toBeUndefined();
    dispose();
  });

  it('As the permissions button, I mark the grants while the read permissions hold one', () => {
    // Given
    const { panel, dispose, given } = mount();
    expect(panel.hasGrants()).toBe(false);

    // When
    given(LOADED, read(['ask', 'granted']));

    // Then
    expect(panel.hasGrants()).toBe(true);

    // When
    given(LOADED, read(['denied', 'ask']));

    // Then
    expect(panel.hasGrants()).toBe(false);
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

  it('As a user, a change applies to the app whose permissions were read, its label passed as is, and resolves what failed', async () => {
    // Given
    const markup = '<img id="injected" src="x">';
    const { panel, dispose, intents, given } = mount();
    intents.change.mockResolvedValueOnce({ failed: ['Camera'] });
    given({ status: 'loaded', label: markup }, read(['ask', 'ask'], markup));

    // When
    const failed = await panel.onChange({ Camera: 'granted' });

    // Then
    expect(intents.change).toHaveBeenCalledExactlyOnceWith(markup, { Camera: 'granted' });
    expect(failed).toEqual(['Camera']);
    dispose();
  });

  it('As a user, nothing is changed while no permissions are read', async () => {
    // Given
    const { panel, dispose, intents, given } = mount();
    given(LOADED, { status: 'reading', label: 'app' });

    // When
    const failed = await panel.onChange({ Camera: 'granted' });

    // Then
    expect(failed).toEqual([]);
    expect(intents.change).not.toHaveBeenCalled();
    dispose();
  });

  it('As the permissions panel, a pending change shows its targets over the statuses read and marks the panel pending', () => {
    // Given
    const { panel, dispose, given, pending } = mount();
    given(LOADED, read(['ask', 'denied']));

    // When
    pending.set({ label: 'app', targets: { Camera: 'granted' } });
    flush();

    // Then
    expect(panel.statuses()).toEqual(['granted', 'denied']);
    expect(panel.pending()).toBe(true);

    // When
    pending.set(null);
    flush();

    // Then
    expect(panel.statuses()).toEqual(['ask', 'denied']);
    expect(panel.pending()).toBe(false);
    dispose();
  });

  it('As the permissions panel, a pending change of the app shown before is not laid over this one', () => {
    // Given
    const { panel, dispose, given, pending } = mount();
    pending.set({ label: 'other', targets: { Camera: 'granted' } });

    // When
    given(LOADED, read(['ask', 'ask']));

    // Then
    expect(panel.statuses()).toEqual(['ask', 'ask']);
    expect(panel.pending()).toBe(false);
    dispose();
  });
});
