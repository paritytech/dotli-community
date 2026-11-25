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
    const { operations } = setup();

    // When
    const first = await operations.beginOperation(PRODUCT, 'send');
    const second = await operations.beginOperation(PRODUCT, '');
    await operations.endOperation(PRODUCT, first.id);
    const third = await operations.beginOperation(PRODUCT, 'send');

    // Then
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });

  it('As a product developer with a worker product, I keep operations open and the network stays held until the last one ends', async () => {
    // Given
    const { operations, network } = setup();
    const held: boolean[] = [];

    // When
    const first = await operations.beginOperation(PRODUCT, 'send');
    const second = await operations.beginOperation(PRODUCT, 'sync');
    held.push(network.isHeld());
    await operations.endOperation(PRODUCT, first.id);
    held.push(network.isHeld());
    await operations.endOperation(PRODUCT, second.id);
    held.push(network.isHeld());

    // Then
    expect(held).toEqual([true, true, false]);
  });

  it('As a product developer with a worker product, I end an operation twice and the other open one still holds the network', async () => {
    // Given
    const { operations, network } = setup();
    const first = await operations.beginOperation(PRODUCT, 'send');
    await operations.beginOperation(PRODUCT, 'sync');

    // When
    await operations.endOperation(PRODUCT, first.id);
    await operations.endOperation(PRODUCT, first.id);

    // Then
    expect(network.isHeld()).toBe(true);
  });

  it('As a user, I leave a product whose worker never ended its operation and the network is let go', async () => {
    // Given
    const { operations, network, core } = setup();
    await operations.beginOperation(PRODUCT, 'send');

    // When
    core.abort();

    // Then
    expect(network.isHeld()).toBe(false);
  });

  it('As a product developer with a worker product, I open an operation after the core ended and the network is not held', async () => {
    // Given
    const { operations, network, core } = setup();
    core.abort();

    // When
    await operations.beginOperation(PRODUCT, 'send');

    // Then
    expect(network.isHeld()).toBe(false);
  });
});

function setup() {
  const core = new AbortController();
  let holds = 0;
  const operations = createProductOperations({
    core: { ended: core.signal },
    holdNetwork: () => {
      holds += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          holds -= 1;
        }
      };
    },
  });
  return { operations, core, network: { isHeld: () => holds > 0 } };
}
