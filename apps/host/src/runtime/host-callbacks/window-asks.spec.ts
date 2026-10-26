// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ProductContext } from '@parity/truapi-host';
import { createBlockingModalCoordinator } from '../blocking-modal-queue.js';
import { createPhoneRequestTracker } from '../phone-requests.js';
import { windowAsks } from './window-asks.js';

const PRODUCT: ProductContext = { productId: 'myapp.paseo', executionKind: 'App' };

describe('the session window answering its core', () => {
  it('As a site in the session window, I ask for a signature and it is allowed once with no prompt and nothing stored', async () => {
    // Given the session window's asks
    const { permissions, userConfirmation } = windowAsks({
      label: 'myapp',
      blockingModalScope: createBlockingModalCoordinator().createScope(),
      phoneRequests: createPhoneRequestTracker(),
    });
    const review = {
      tag: 'AccountAccess',
      value: { requestingProductId: 'a.dot', targetProductId: 'b.dot' },
    } as const;

    // When the core asks for each permission and confirmation
    const answers = {
      remote: await permissions.remotePermission(PRODUCT, { permission: { tag: 'ChainSubmit' } }),
      device: await permissions.devicePermission(PRODUCT, 'Camera'),
      action: await userConfirmation.confirmUserAction(review),
      permission: await userConfirmation.confirmPermission(review),
    };

    // Then each is allowed once
    expect(answers).toEqual({ remote: 'AllowOnce', device: 'AllowOnce', action: true, permission: 'AllowOnce' });
  });
});
