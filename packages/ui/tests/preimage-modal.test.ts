// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { showPreimageSubmitModal } from '../src/preimage-modal.js';
import { ERRORS } from '../src/errors.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';
import { byTestId, query } from './support.js';

afterEach(() => {
  resetOverlays();
  document.body.replaceChildren();
});

describe('preimage submit modal', () => {
  it('As a dotli user, I see the data size and can allow the submission', async () => {
    // Given
    const decision = showPreimageSubmitModal(2048);
    await overlaysReady();

    // Then
    expect(query(byTestId('signing-modal'), 'h2').textContent).toBe('Submit Preimage');
    expect(
      byTestId('permission-modal-icon').querySelector('path[d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"]'),
    ).not.toBeNull();
    expect(byTestId('signing-field-label').textContent).toBe('Data size');
    expect(byTestId('signing-field-value').textContent).toBe('2 KB');

    // When
    byTestId('signing-btn-sign').click();

    // Then
    await expect(decision).resolves.toBeUndefined();
  });

  it('As a dotli user, cancelling rejects with the pinned error, and the backdrop does nothing', async () => {
    // Given
    const decision = showPreimageSubmitModal(512);
    await overlaysReady();
    expect(byTestId('signing-field-value').textContent).toBe('512 B');
    expect(byTestId('signing-btn-cancel').dataset['variant']).toBe('secondary');

    // When
    byTestId('signing-modal-backdrop').click();

    // Then
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).not.toBeNull();

    // When
    byTestId('signing-btn-cancel').click();

    // Then
    await expect(decision).rejects.toThrow(ERRORS.PREIMAGE_SUBMIT_DENIED);
  });

  it('As a dotli integrator, an abort rejects with AbortError and closes the dialog', async () => {
    // Given
    const controller = new AbortController();
    const decision = showPreimageSubmitModal(10, controller.signal);
    await overlaysReady();

    // When
    controller.abort();

    // Then
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' });
  });
});
