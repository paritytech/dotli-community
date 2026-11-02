// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import type { ProductContext } from '@parity/truapi-host';
import { createBlockingModalCoordinator } from '../createBlockingModalCoordinator.js';
import { createHostCallbacks } from './createHostCallbacks.js';
import { createPromptAsks } from './createPromptAsks.js';
import { SUBMIT_MAX_PER_WINDOW } from './createSubmitRateLimiter.js';
import type { NotificationScheduler } from './createNotificationAdapters.js';
import type { HostPrompts } from '../hostPrompts.js';
import { createFakePrompts } from '../hostPrompts.fake.js';
import { encodePhoneRequestFrame } from '../../testing/encodePhoneRequestFrame.js';
import { createPhoneRequestTracker } from '../createPhoneRequestTracker.js';
import { createPermissionAuthorizations } from '../createPermissionAuthorizations.js';
import { createProductPermissions } from '../state/productPermissions.js';
import { productState } from '../state/productState.js';
import { getWindowAsks } from './getWindowAsks.js';
import type { PromptPermissionStores } from './createPromptPermission.js';

type PermissionAsk = HostPrompts['askPermission'];

const PRODUCT: ProductContext = {
  productId: 'myapp.paseo',
  executionKind: 'App',
};

/** Schedules for later with id 7, so delivering shows nothing. */
const scheduler: NotificationScheduler = {
  schedule: () => Promise.resolve({ ok: true, id: 7, immediate: false }),
  cancel: () => Promise.resolve(true),
};

afterEach(() => {
  resetAllStoresForTests();
});

describe('blocking modal queue across host callbacks', () => {
  it('As a dotli integrator, I raise a user confirmation and a device permission prompt and the host shows them one at a time', async () => {
    // Given
    const scope = createBlockingModalCoordinator().createScope();
    onTestFinished(() => {
      scope.dispose();
    });
    const page = createFakePrompts();
    const callbacks = createHostCallbacks({
      label: 'localhost:3000',
      phoneRequests: createPhoneRequestTracker(),
      blockingModalScope: scope,
      ...buildPromptAsks(page.prompts),
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
    await page.waitForPrompt({
      matches: prompt => prompt.kind === 'review' && prompt.dialog.title === 'Account Access',
    });

    // Then
    expect(page.listPending()).toHaveLength(1);

    // When
    page.chooseReviewButton('Allow');
    await page.waitForPrompt({ matches: prompt => prompt.kind === 'permission' });

    // Then
    await expect(accountAccess).resolves.toBe(true);
    expect(page.listPending()).toHaveLength(1);

    // When
    page.decide('granted');

    // Then
    await expect(camera).resolves.toEqual('AllowAlways');
    expect(page.listPending()).toEqual([]);
  });

  it('As a user with a paired phone, I allow an account access and it waits on the phone before the next prompt', async () => {
    // Given
    const scope = createBlockingModalCoordinator().createScope();
    const page = createFakePrompts();
    const phoneRequests = createPhoneRequestTracker();
    onTestFinished(() => {
      scope.dispose();
      phoneRequests.dispose();
    });
    const tap = phoneRequests.connect();
    const callbacks = createHostCallbacks({
      label: 'localhost:3000',
      blockingModalScope: scope,
      ...buildPromptAsks(page.prompts),
      notifications: scheduler,
      phoneRequests,
    });
    tap.fromProduct(
      encodePhoneRequestFrame({
        requestId: 'a',
        method: 'getAccount',
        body: {
          productAccountId: { dotNsIdentifier: 'other-product.dot', derivationIndex: { tag: 'Index', value: 0 } },
        },
      }),
    );
    const accountAccess = callbacks.userConfirmation.confirmUserAction({
      tag: 'AccountAccess',
      value: { requestingProductId: 'truapi-playground.dot', targetProductId: 'other-product.dot' },
    });
    const camera = callbacks.permissions.devicePermission(PRODUCT, 'Camera');
    await page.waitForPrompt({
      matches: prompt => prompt.kind === 'review' && prompt.dialog.title === 'Account Access',
    });

    // When
    page.chooseReviewButton('Allow');

    // Then
    await expect(accountAccess).resolves.toBe(true);
    expect(page.listPending()).toHaveLength(1);
    expect(page.getShownReview().buttons.map(button => button.label)).toEqual(['Wait in background']);

    // When
    page.chooseReviewButton('Wait in background');
    await page.waitForPrompt({ matches: prompt => prompt.kind === 'permission' });
    page.decide('granted');

    // Then
    await expect(camera).resolves.toEqual('AllowAlways');
  });
});

describe('session window asks across host callbacks', () => {
  it("As a user in the session window, I let the core ask and the window answers while the page's prompts never show", async () => {
    // Given host callbacks with the session window's asks over the page's prompts
    const page = createFakePrompts();
    const askPermission = vi.fn<PermissionAsk>(page.prompts.askPermission);
    const callbacks = createHostCallbacks({
      label: 'localhost:3000',
      phoneRequests: createPhoneRequestTracker(),
      blockingModalScope: createBlockingModalCoordinator().createScope(),
      prompts: { ...page.prompts, askPermission },
      createAsks: getWindowAsks,
      notifications: scheduler,
    });

    // When the core asks for the camera and confirms an account access
    const camera = await callbacks.permissions.devicePermission(PRODUCT, 'Camera');
    const confirmed = await callbacks.userConfirmation.confirmUserAction({
      tag: 'AccountAccess',
      value: { requestingProductId: 'truapi-playground.dot', targetProductId: 'other-product.dot' },
    });

    // Then both are allowed and no page prompt was asked
    expect([camera, confirmed]).toEqual(['AllowOnce', true]);
    expect(askPermission).not.toHaveBeenCalled();
    expect(page.listPending()).toEqual([]);
  });
});

describe('notifications across host callbacks', () => {
  it('As a user who allowed one notification, I get it delivered and am not prompted again', async () => {
    // Given the core already authorized and consumed the one-time grant, so
    // no stored grant is left for a host-side check to find
    const schedule = vi.fn<NotificationScheduler['schedule']>(() =>
      Promise.resolve({ ok: true, id: 7, immediate: true }),
    );
    const ask = vi.fn<PermissionAsk>(() => Promise.resolve('granted'));
    const { notifications } = createHostCallbacks({
      label: 'myapp',
      phoneRequests: createPhoneRequestTracker(),
      blockingModalScope: createBlockingModalCoordinator().createScope(),
      notifications: { schedule, cancel: () => Promise.resolve(true) },
      ...buildPromptAsks(createPromptsAnswering(ask)),
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

  it('As a dotli integrator, I spend the prompt budget of one callback surface and its next prompt of any kind is rate limited', async () => {
    // Given a single host callback surface. No authorization provider is
    // registered, so every prompt reaches the "ask" path and the limiter.
    const { permissions } = createHostCallbacks({
      label: 'myapp',
      phoneRequests: createPhoneRequestTracker(),
      blockingModalScope: createBlockingModalCoordinator().createScope(),
      notifications: scheduler,
      ...buildPromptAsks(createPromptsAnswering(ask)),
    });

    // When camera prompts exhaust the whole window budget, and a different permission asks next
    for (let prompt = 0; prompt < SUBMIT_MAX_PER_WINDOW; prompt += 1) {
      await permissions.devicePermission(PRODUCT, 'Camera');
    }
    const overBudget = permissions.devicePermission(PRODUCT, 'Notifications');

    // Then it shares that budget and is rate limited instead of showing one modal over the budget
    await expect(overBudget).rejects.toThrow('Permission prompt rate limited');
    expect(ask).toHaveBeenCalledTimes(SUBMIT_MAX_PER_WINDOW);
  });

  it('As a user, I get many notifications delivered and my prompts still pass', async () => {
    // Given one callback surface, whose prompts and notifications share its one limiter
    const { permissions, notifications } = createHostCallbacks({
      label: 'myapp',
      phoneRequests: createPhoneRequestTracker(),
      blockingModalScope: createBlockingModalCoordinator().createScope(),
      notifications: scheduler,
      ...buildPromptAsks(createPromptsAnswering(ask)),
    });

    // When more notifications than the whole prompt budget are delivered, then the prompts spend that budget and one
    // more prompt and one more notification follow
    const delivered: unknown[] = [];
    for (let notice = 0; notice < SUBMIT_MAX_PER_WINDOW * 2; notice += 1) {
      delivered.push(await notifications.pushNotification({ text: `hello ${String(notice)}` }));
    }
    for (let prompt = 0; prompt < SUBMIT_MAX_PER_WINDOW; prompt += 1) {
      await permissions.devicePermission(PRODUCT, 'Camera');
    }
    const afterTheBudget = await notifications.pushNotification({ text: 'after the budget' });
    const overBudget = permissions.devicePermission(PRODUCT, 'Camera');

    // Then every notification went out, the full prompt budget was still there, and no more
    expect(delivered).toEqual(Array.from({ length: SUBMIT_MAX_PER_WINDOW * 2 }, () => ({ id: 7 })));
    expect(ask).toHaveBeenCalledTimes(SUBMIT_MAX_PER_WINDOW);
    await expect(overBudget).rejects.toThrow('Permission prompt rate limited');
    expect(afterTheBudget).toEqual({ id: 7 });
  });
});

/** Prompts that answer permissions with `ask` and leave every other ask waiting. */
function createPromptsAnswering(ask: PermissionAsk): HostPrompts {
  return { ...createFakePrompts().prompts, askPermission: ask };
}

/** A registry with no connection, so every prompt reaches the ask, and a store over it. */
function createTestPermissions(): PromptPermissionStores {
  const registry = createPermissionAuthorizations();
  return { registry, product: createProductPermissions({ registry, product: productState.store }) };
}

/** The prompts and the asks that answer through them, over a registry with no connection. */
function buildPromptAsks(prompts: HostPrompts): {
  prompts: HostPrompts;
  createAsks: ReturnType<typeof createPromptAsks>;
} {
  return { prompts, createAsks: createPromptAsks({ prompts, permissions: createTestPermissions() }) };
}
