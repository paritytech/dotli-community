// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatSize } from '@dotli/shared';
import type { ModalView } from '@dotli/ui';
import { permissionIcon } from '@dotli/ui-entities';

/** `allow` lets the app submit the preimage. */
export type PreimageDecision = 'cancel' | 'allow';

/** The dialog that asks before an app stores `dataSize` bytes of preimage data. */
export function preimageSubmitDialog(dataSize: number): ModalView<PreimageDecision> {
  return {
    icon: permissionIcon('PreimageSubmit'),
    title: 'Submit Preimage',
    fields: [{ label: 'Data size', value: formatSize(dataSize) }],
    buttons: [
      { label: 'Cancel', variant: 'cancel', result: 'cancel' },
      { label: 'Allow', variant: 'primary', result: 'allow' },
    ],
    dismissOnBackdrop: false,
  };
}
