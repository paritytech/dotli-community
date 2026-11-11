// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { asProductId } from '@parity/truapi';
import { describe, expect, it } from 'vitest';
import type { ProductContext } from '@parity/truapi-host';
import { createProductOperations } from './createProductOperations.js';

// Operations belong to Worker executions.
const PRODUCT: ProductContext = {
  productId: asProductId('chat.dot'),
  executionKind: 'Worker',
};

describe('product operations', () => {
  it('As a product developer with a worker product, I open operations and each gets its own id', async () => {
    // Given
    const operations = createProductOperations();

    // When
    const first = await operations.beginOperation(PRODUCT, 'send');
    const second = await operations.beginOperation(PRODUCT, '');
    await operations.endOperation(PRODUCT, first.id);
    const third = await operations.beginOperation(PRODUCT, 'send');

    // Then
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });
});
