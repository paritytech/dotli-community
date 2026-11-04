// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';
import { asProductId } from '@parity/truapi';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import { createFakeProvider, type FakeCoreProvider } from '../createPageCore.fake.js';

type Params = {
  /** The core's provider, a fresh fake one by default. */
  provider?: FakeCoreProvider;
};

/** A core lease over `provider`, recording each connect, close and release. */
export function createFakeCoreLease({ provider = createFakeProvider() }: Params = {}) {
  const connection = {
    // The fake is a partial provider, enough for the calls under test.
    provider: provider as unknown as TrUApiProductProvider,
    productId: asProductId('dotli-product'),
    close: vi.fn(),
  };
  const lease = { connect: vi.fn(() => Promise.resolve(connection)), release: vi.fn() };
  const acquire = vi.fn(() => Promise.resolve(lease));
  return { acquire, lease, connection };
}
