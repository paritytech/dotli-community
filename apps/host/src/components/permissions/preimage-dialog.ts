// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatSize } from '@dotli/shared';
import type { ModalView } from '@dotli/ui';
import { permissionIcon } from './permission-icons.js';

/** `allow` lets the app submit the preimage. */
export type PreimageDecision = 'cancel' | 'allow';

export interface PreimageRequest {
  /** The app's name as the user reads it. */
  app: string;
  dataSize: number;
}

/** The dialog that asks before `app` stores `dataSize` bytes of preimage data. */
export function preimageSubmitDialog({ app, dataSize }: PreimageRequest): ModalView<PreimageDecision> {
  return {
    icon: permissionIcon('PreimageSubmit'),
    title: 'Submit Preimage',
    fields: [
      { label: 'Application', value: app },
      { label: 'Data size', value: formatSize(dataSize) },
    ],
    buttons: [
      { label: 'Cancel', variant: 'cancel', result: 'cancel' },
      { label: 'Allow', variant: 'primary', result: 'allow' },
    ],
    dismissOnBackdrop: false,
  };
}
