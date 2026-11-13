// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { asProductId } from '@parity/truapi';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import type { ProductContext } from '@parity/truapi-host';
import { createBlockingModalCoordinator } from '../createBlockingModalCoordinator.js';
import { createFakePrompts } from '../hostPrompts.fake.js';
import { createPhoneRequestTracker } from '../createPhoneRequestTracker.js';
import { createPermissionAuthorizations } from '../createPermissionAuthorizations.js';
import { createProductPermissions } from '../state/productPermissions.js';
import { productState } from '../state/productState.js';
import { createPromptAsks } from './createPromptAsks.js';

const PRODUCT: ProductContext = {
  productId: asProductId('myapp.paseo'),
  executionKind: 'App',
};

afterEach(() => {
  resetAllStoresForTests();
});

describe('one core asks', () => {
  it('As a dotli integrator, I raise a user confirmation and a device permission prompt and the host shows them one at a time', async () => {
    // Given a core's asks over a registry with no connection, so the permission reaches the prompt
    const scope = createBlockingModalCoordinator().createScope();
    onTestFinished(() => {
      scope.dispose();
    });
    const page = createFakePrompts();
    const registry = createPermissionAuthorizations();
    const asks = createPromptAsks({
      prompts: page.prompts,
      permissions: { registry, product: createProductPermissions({ registry, product: productState.store }) },
    })({
      product: { label: 'localhost:3000' },
      blockingModalScope: scope,
      phoneRequests: createPhoneRequestTracker(),
      isLive: () => true,
      isInService: () => true,
      sessionInMemory: false,
    });

    // When
    const accountAccess = asks.userConfirmation.confirmUserAction({
      tag: 'AccountAccess',
      value: {
        requestingProductId: asProductId('truapi-playground.dot'),
        targetProductId: asProductId('other-product.dot'),
      },
    });
    const camera = asks.permissions.devicePermission(PRODUCT, 'Camera');
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
