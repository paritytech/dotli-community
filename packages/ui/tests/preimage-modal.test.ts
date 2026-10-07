// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PreimageSubmitReview } from '@parity/truapi-host';
import { afterEach, describe, expect, it } from 'vitest';
import { showPreimageSubmitModal } from '../src/preimage-modal.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';
import { must } from './support.js';

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
    ['Allow once', 'AllowOnce'],
    ['Allow bounded automatic uploads', 'AllowAlways'],
    ['Deny', 'Deny'],
  ] as const)('preserves the explicit lifetime chosen with %s', async (label, expected) => {
    const decision = showPreimageSubmitModal(REVIEW);
    await overlaysReady();
    must(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.signing-modal button')).find(
        button => button.textContent === label,
      ),
      label,
    ).click();
    await expect(decision).resolves.toBe(expected);
    expect(document.querySelector('.signing-modal')).toBeNull();
  });

  it('does not turn a backdrop click into upload consent', async () => {
    const decision = showPreimageSubmitModal(REVIEW);
    await overlaysReady();
    document.querySelector<HTMLElement>('.signing-modal-backdrop')?.click();
    expect(document.querySelector('.signing-modal-backdrop')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('.signing-btn-cancel')?.click();
    await expect(decision).resolves.toBe('Deny');
  });

  it('rejects an aborted review and cannot accept a stale automatic-consent button', async () => {
    const controller = new AbortController();
    const decision = showPreimageSubmitModal(REVIEW, controller.signal);
    await overlaysReady();
    const automatic = must(
      document.querySelector<HTMLButtonElement>('.signing-btn-secondary'),
      'automatic upload button',
    );
    controller.abort();
    automatic.click();
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' });
    expect(document.querySelector('.signing-modal')).toBeNull();
  });
});
