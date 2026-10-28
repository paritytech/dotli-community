// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { SANDBOX_ERRORS } from './errors.js';
import { storeArchiveInServiceWorker } from './storeArchiveInServiceWorker.js';

describe('storeArchiveInServiceWorker', () => {
  it('As a visitor whose service worker could not start, I open the product and the load fails instead of writing a page with no files', async () => {
    // Given a page no service worker controls
    const container = { controller: null, addEventListener: () => undefined, removeEventListener: () => undefined };
    const files = { 'index.html': new Uint8Array([60]), 'app.js': new Uint8Array([59]) };

    // When
    const stored = storeArchiveInServiceWorker({ container, files, pagePath: '/' });

    // Then
    await expect(stored).rejects.toThrow(SANDBOX_ERRORS.SW_NOT_CONTROLLING);
  });
});
