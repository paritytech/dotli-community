// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { ERRORS } from './errors.js';
import { presentModal } from './overlays/load.js';
import { iconMarkup, PERMISSION_ICONS } from './permission-icons.js';

function formatSize(bytes: number): string {
  return bytes >= 1024 ? `${String(Math.round(bytes / 1024))} KB` : `${String(bytes)} B`;
}

export async function showPreimageSubmitModal(dataSize: number, signal?: AbortSignal): Promise<void> {
  const { result } = await presentModal<'cancel' | 'allow'>(
    {
      icon: iconMarkup(PERMISSION_ICONS.PreimageSubmit),
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
