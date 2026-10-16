// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { PERMISSION_ICONS } from '../src/permission-icons.js';
import { showPreimageRetainModal, showPreimageSubmitModal } from '../src/preimage-modal.js';
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
      byTestId('permission-modal-icon').querySelector(`path[d="${PERMISSION_ICONS.PreimageSubmit}"]`),
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

describe('preimage retain modal', () => {
  const fields = (): string[][] =>
    Array.from(document.querySelectorAll('[data-testid="signing-field-label"]'), (label, i) => [
      label.textContent,
      document.querySelectorAll('[data-testid="signing-field-value"]')[i]?.textContent ?? '',
    ]);

  it('As a person, I see the price of one day of a retention that renews until I stop it, and the first day that I pay now', async () => {
    // Given a file of 3 MB that a node keeps for 6 credits a day, with no end
    const decision = showPreimageRetainModal({
      label: 'keepcached.paseo',
      items: [{ size: 3_000_000, periodSecs: 0, renews: true, node: 'A, eu-west', price: 6 }],
      funds: { free: 48, paid: 100 },
    });
    await overlaysReady();

    // Then the modal gives the price of a day and the end, not the price of a period
    expect(fields()).toEqual([
      ['App', 'keepcached.paseo'],
      ['File size', '2.9 MB'],
      ['Keep', 'renewed daily until you stop'],
      ['Cache node', 'A, eu-west'],
      ['Price', '6 credits a day, until you stop, the first day from the free allowance (48 left today)'],
    ]);

    // When
    byTestId('signing-btn-cancel').click();

    // Then
    await expect(decision).resolves.toBe(false);
  });

  it('As a person, I see the date at which the renewals of an item end', async () => {
    // Given an item that renews for a week
    const end = new Date(Date.now() + 7 * 86_400_000).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    const decision = showPreimageRetainModal({
      label: 'keepcached.paseo',
      items: [{ size: 100, periodSecs: 7 * 86_400, renews: true, node: 'A', price: 1 }],
    });
    await overlaysReady();

    // Then
    expect(fields().find(([label]) => label === 'Price')).toEqual(['Price', `1 credit a day, until ${end}`]);
    byTestId('signing-btn-cancel').click();
    await expect(decision).resolves.toBe(false);
  });
});
