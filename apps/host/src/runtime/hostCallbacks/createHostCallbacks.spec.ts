// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { asProductId } from '@parity/truapi';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import type { ProductContext } from '@parity/truapi-host';
import { createBlockingModalCoordinator } from '../createBlockingModalCoordinator.js';
import type { CoreContext } from '../createPageCore.js';
import { createHostCallbacks } from './createHostCallbacks.js';
import { createPromptAsks } from './createPromptAsks.js';
import { SUBMIT_MAX_PER_WINDOW } from './createSubmitRateLimiter.js';
import type { NotificationScheduler } from './createNotificationAdapters.js';
import type { HostPrompts } from '../hostPrompts.js';
import { createFakePrompts } from '../hostPrompts.fake.js';
import { createPhoneRequestTracker } from '../createPhoneRequestTracker.js';
import { createPermissionAuthorizations } from '../createPermissionAuthorizations.js';
import { createProductPermissions } from '../state/productPermissions.js';
import { productState } from '../state/productState.js';
import type { PromptPermissionStores } from './createPromptPermission.js';

type PermissionAsk = HostPrompts['askPermission'];

const PRODUCT: ProductContext = {
  productId: asProductId('myapp.paseo'),
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
      core: createCore({ blockingModalScope: scope }),
      getProductId: () => PRODUCT.productId,
      sessionInMemory: false,
      ...buildPromptAsks(page.prompts),
      notifications: scheduler,
    });

    // When
    const accountAccess = callbacks.userConfirmation.confirmUserAction({
      tag: 'AccountAccess',
      value: {
        requestingProductId: asProductId('truapi-playground.dot'),
        targetProductId: asProductId('other-product.dot'),
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
      core: createCore({ product: { label: 'myapp' } }),
      getProductId: () => PRODUCT.productId,
      sessionInMemory: false,
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
});

/** A core for localhost with a fresh queue scope and phone tracker, live and in service, with `overrides` applied. */
function createCore(overrides: Partial<CoreContext> = {}): CoreContext {
  return {
    product: { label: 'localhost:3000' },
    blockingModalScope: overrides.blockingModalScope ?? createBlockingModalCoordinator().createScope(),
    phoneRequests: overrides.phoneRequests ?? createPhoneRequestTracker(),
    isLive: () => true,
    isInService: () => true,
    sessionInMemory: false,
    ...overrides,
  };
}

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
