// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createRoot, flush } from 'solid-js';
import { createSyncStore } from '@dotli/shared';
import type { PermissionStatus } from '../runtime/permissions.js';
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
  const intents = {
    refresh: vi.fn(() => Promise.resolve()),
    choose: vi.fn(() => Promise.resolve()),
    reset: vi.fn(() => Promise.resolve()),
  };
  const { panel, dispose } = createRoot(d => ({
    panel: usePermissionsPanel({ permissions: PERMISSIONS, product, state, ...intents }),
    dispose: d,
  }));
  flush();
  const given = (shown: ShownProduct, read: ReadPermissions): void => {
    product.set(shown);
    state.set(read);
    flush();
  };
  return { panel, dispose, intents, given };
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

  it('As a user, a status I press and Reset all apply to the app whose permissions were read, its label passed as is', async () => {
    // Given
    const markup = '<img id="injected" src="x">';
    const { panel, dispose, intents, given } = mount();
    given({ status: 'loaded', label: markup }, read(['ask', 'ask'], markup));

    // When
    panel.onChoose('Camera', 'granted');
    await panel.onReset();

    // Then
    expect(intents.choose).toHaveBeenCalledExactlyOnceWith(markup, 'Camera', 'granted');
    expect(intents.reset).toHaveBeenCalledExactlyOnceWith(markup);
    dispose();
  });

  it('As a user, nothing is changed while no permissions are read', async () => {
    // Given
    const { panel, dispose, intents, given } = mount();
    given(LOADED, { status: 'reading', label: 'app' });

    // When
    panel.onChoose('Camera', 'granted');
    await panel.onReset();

    // Then
    expect(intents.choose).not.toHaveBeenCalled();
    expect(intents.reset).not.toHaveBeenCalled();
    dispose();
  });
});
