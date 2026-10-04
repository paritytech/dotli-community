// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Preimage submit confirmation modal
//
// Shows a confirmation dialog when a product requests to store
// preimage data on the Bulletin chain. Returns a Promise that
// resolves on "Allow" and rejects on "Cancel".
//
// Rendered by the overlays root (components/overlays/SigningDialog.tsx).

import { ERRORS } from './errors.js';
import { presentModal } from './overlays/load.js';
import { PERMISSION_ICONS } from './permission-modal.js';

function formatSize(bytes: number): string {
  return bytes >= 1024 ? `${String(Math.round(bytes / 1024))} KB` : `${String(bytes)} B`;
}

export async function showPreimageSubmitModal(dataSize: number, signal?: AbortSignal): Promise<void> {
  const { result } = await presentModal<'cancel' | 'allow'>(
    {
      // The same upload glyph as the PreimageSubmit permission.
      icon: PERMISSION_ICONS.PreimageSubmit,
      title: 'Submit Preimage',
      fields: [{ label: 'Data size', value: formatSize(dataSize) }],
      buttons: [
        { label: 'Cancel', variant: 'cancel', result: 'cancel' },
        { label: 'Allow', variant: 'primary', result: 'allow' },
      ],
      dismissOnBackdrop: false,
      fallbackResult: 'cancel',
    },
    signal,
  );
  if (result !== 'allow') {
    throw new Error(ERRORS.PREIMAGE_SUBMIT_DENIED);
  }
}
