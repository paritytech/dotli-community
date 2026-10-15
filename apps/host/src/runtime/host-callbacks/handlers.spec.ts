// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductContext } from '@parity/truapi-host';
import { createBlockingModalCoordinator } from '../blocking-modal-queue.js';
import { createHostCallbacks } from './handlers.js';
import { SUBMIT_MAX_PER_WINDOW } from './rate-limit.js';
import type { NotificationScheduler } from './push-notification.js';
import type { HostPrompts } from '../host-prompts.js';
import { createFakePrompts } from '../host-prompts.fake.js';
import { createPermissionAuthorizations } from '../permissions.js';
import { createProductPermissions } from '../state/product-permissions.js';
import { productStore } from '../state/product.js';
import type { PromptPermissionStores } from './prompt-permission.js';

const PRODUCT: ProductContext = {
  productId: 'myapp.paseo',
  executionKind: 'App',
};

type PermissionAsk = HostPrompts['askPermission'];

/** Prompts that answer permissions with `ask` and leave every other ask waiting. */
function promptsWith(ask: PermissionAsk): HostPrompts {
  return { ...createFakePrompts().prompts, askPermission: ask };
}

/** A registry with no connection, so every prompt reaches the ask, and a store over it. */
function permissionsOfTest(): PromptPermissionStores {
  const registry = createPermissionAuthorizations();
  return { registry, product: createProductPermissions({ registry, product: productStore }) };
}

/** Schedules for later with id 7, so delivering shows nothing. */
const scheduler: NotificationScheduler = {
  schedule: () => Promise.resolve({ ok: true, id: 7, immediate: false }),
  cancel: () => Promise.resolve(true),
};

describe('blocking modal queue across host callbacks', () => {
  it('As a dotli integrator, I raise a user confirmation and a device permission prompt and the host shows them one at a time', async () => {
    // Given
    const scope = createBlockingModalCoordinator().createScope();
    const page = createFakePrompts();
    const callbacks = createHostCallbacks({
      permissions: permissionsOfTest(),
      label: 'localhost:3000',
      blockingModalScope: scope,
      prompts: page.prompts,
      notifications: scheduler,
    });

    // When
    const accountAccess = callbacks.userConfirmation.confirmUserAction({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    const camera = callbacks.permissions.devicePermission(PRODUCT, 'Camera');
    await page.promptShown(prompt => prompt.kind === 'review' && prompt.dialog.title === 'Account Access');

    // Then
    expect(page.pending()).toHaveLength(1);

    // When
    page.chooseReviewButton('Allow');

    // Then
    await expect(accountAccess).resolves.toBe(true);
    await page.promptShown(prompt => prompt.kind === 'permission');
    expect(page.pending()).toHaveLength(1);

    // When
    page.decide('granted');

    // Then
    await expect(camera).resolves.toEqual('AllowAlways');
    expect(page.pending()).toEqual([]);
    scope.dispose();
  });
});

describe('notifications across host callbacks', () => {
  /** Schedules with id 7, fired at once. */
  function fakeScheduler(): {
    scheduler: NotificationScheduler;
    schedule: ReturnType<typeof vi.fn<NotificationScheduler['schedule']>>;
  } {
    const schedule = vi.fn<NotificationScheduler['schedule']>(() =>
      Promise.resolve({ ok: true, id: 7, immediate: true }),
    );
    return { scheduler: { schedule, cancel: () => Promise.resolve(true) }, schedule };
  }

  it('As a dotli user who allowed one notification, delivering it does not prompt again', async () => {
    // Given: the core already authorized and consumed the one-time grant, so
    // no stored grant is left for a host-side check to find.
    const { scheduler, schedule } = fakeScheduler();
    const ask = vi.fn<PermissionAsk>(() => Promise.resolve('granted'));
    const { notifications } = createHostCallbacks({
      permissions: permissionsOfTest(),
      label: 'myapp',
      blockingModalScope: createBlockingModalCoordinator().createScope(),
      notifications: scheduler,
      prompts: promptsWith(ask),
    });

    // When
    await notifications.pushNotification({
      text: 'hello',
    });

    // Then
    expect(ask).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});

describe('prompt rate limiting across host callbacks', () => {
  let ask = vi.fn<PermissionAsk>();

  beforeEach(() => {
    ask = vi.fn<PermissionAsk>(() => Promise.resolve('granted'));
  });

  it('As a dotli integrator, the host rate limits permission prompts per callback surface', async () => {
    // Given: a single host callback surface. No authorization provider is
    // registered, so every prompt reaches the "ask" path and the limiter.
    const { permissions } = createHostCallbacks({
      permissions: permissionsOfTest(),
      label: 'myapp',
      blockingModalScope: createBlockingModalCoordinator().createScope(),
      notifications: scheduler,
      prompts: promptsWith(ask),
    });

    // When: camera prompts exhaust the whole window budget.
    for (let i = 0; i < SUBMIT_MAX_PER_WINDOW; i += 1) {
      await permissions.devicePermission(PRODUCT, 'Camera');
    }

    // Then: a different permission shares that budget and is rate limited
    // instead of showing one modal over the budget.
    await expect(permissions.devicePermission(PRODUCT, 'Notifications')).rejects.toThrow(
      'Permission prompt rate limited',
    );
    expect(ask).toHaveBeenCalledTimes(SUBMIT_MAX_PER_WINDOW);
  });

  it('As a dotli user, I get many notifications delivered and my prompts still pass', async () => {
    // Given: one callback surface, whose prompts and notifications share its one limiter
    const { permissions, notifications } = createHostCallbacks({
      permissions: permissionsOfTest(),
      label: 'myapp',
      blockingModalScope: createBlockingModalCoordinator().createScope(),
      notifications: scheduler,
      prompts: promptsWith(ask),
    });

    // When: more notifications than the whole prompt budget are delivered
    for (let i = 0; i < SUBMIT_MAX_PER_WINDOW * 2; i += 1) {
      await expect(notifications.pushNotification({ text: `hello ${String(i)}` })).resolves.toEqual({ id: 7 });
    }

    // Then: the full prompt budget is still there, and no more
    for (let i = 0; i < SUBMIT_MAX_PER_WINDOW; i += 1) {
      await permissions.devicePermission(PRODUCT, 'Camera');
    }
    expect(ask).toHaveBeenCalledTimes(SUBMIT_MAX_PER_WINDOW);
    await expect(permissions.devicePermission(PRODUCT, 'Camera')).rejects.toThrow('Permission prompt rate limited');
    await expect(notifications.pushNotification({ text: 'after the budget' })).resolves.toEqual({ id: 7 });
  });
});
