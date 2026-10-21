// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PreimageSubmitReview } from '@parity/truapi-host';
import { afterEach, describe, expect, it } from 'vitest';
import { showPreimageSubmitModal } from '../src/preimage-modal.js';
import { failAllModals } from '../src/state/modals.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';
import { byTestId } from './support.js';

const REVIEW: PreimageSubmitReview = {
  size: 2048n,
  productId: 'example.paseo',
  rootPublicKey: `0x${'01'.repeat(32)}`,
  genesisHash: `0x${'02'.repeat(32)}`,
  automaticMaxBytes: 262144n,
  automaticMaxUploads: 4,
  automaticWindowSeconds: 3600,
};

afterEach(() => {
  resetOverlays();
  document.body.replaceChildren();
});

describe('preimage submit modal', () => {
  it.each([
    ['signing-btn-sign', 'AllowOnce'],
    ['signing-btn-secondary', 'AllowAlways'],
    ['signing-btn-cancel', 'Deny'],
  ] as const)('preserves the explicit lifetime chosen with %s', async (testId, expected) => {
    const decision = showPreimageSubmitModal(REVIEW);
    await overlaysReady();
    byTestId(testId).click();
    await expect(decision).resolves.toBe(expected);
    expect(document.querySelector('[data-testid="signing-modal"]')).toBeNull();
  });

  it('does not turn a backdrop click into upload consent', async () => {
    const decision = showPreimageSubmitModal(REVIEW);
    await overlaysReady();
    byTestId('signing-modal-backdrop').click();
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).not.toBeNull();
    byTestId('signing-btn-cancel').click();
    await expect(decision).resolves.toBe('Deny');
  });

  it('rejects an aborted review and cannot accept a stale automatic-consent button', async () => {
    const controller = new AbortController();
    const decision = showPreimageSubmitModal(REVIEW, controller.signal);
    await overlaysReady();
    const automatic = byTestId('signing-btn-secondary');
    controller.abort();
    automatic.click();
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' });
    expect(document.querySelector('[data-testid="signing-modal"]')).toBeNull();
  });

  it('denies the review when the overlay fails', async () => {
    const decision = showPreimageSubmitModal(REVIEW);
    await overlaysReady();
    failAllModals();
    await expect(decision).resolves.toBe('Deny');
  });

  it('never opens an already aborted review', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(showPreimageSubmitModal(REVIEW, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(document.querySelector('[data-testid="signing-modal"]')).toBeNull();
  });

  it('renders untrusted scope values as text rather than markup', async () => {
    const productId = '<img src=x onerror="alert(1)">';
    const decision = showPreimageSubmitModal({ ...REVIEW, productId });
    await overlaysReady();
    const modal = byTestId('signing-modal');
    expect(modal.textContent).toContain(productId);
    expect(modal.textContent).toContain(REVIEW.rootPublicKey);
    expect(modal.textContent).toContain(REVIEW.genesisHash);
    expect(modal.querySelector('img')).toBeNull();
    byTestId('signing-btn-cancel').click();
    await expect(decision).resolves.toBe('Deny');
  });

  it('asks again for an oversized review after an automatic grant', async () => {
    const first = showPreimageSubmitModal(REVIEW);
    await overlaysReady();
    byTestId('signing-btn-secondary').click();
    await expect(first).resolves.toBe('AllowAlways');

    const oversized = showPreimageSubmitModal({ ...REVIEW, size: REVIEW.automaticMaxBytes + 1n });
    await overlaysReady();
    expect(byTestId('signing-modal').textContent).toContain('262145 bytes');
    byTestId('signing-btn-cancel').click();
    await expect(oversized).resolves.toBe('Deny');
  });
});
