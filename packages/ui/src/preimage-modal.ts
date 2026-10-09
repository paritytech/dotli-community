// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Upload consent is separate from the Remote PreimageSubmit gate and signing
// permissions. Only an explicit AllowAlways authorizes bounded future uploads.
import type { PermissionDecision, PreimageSubmitReview } from '@parity/truapi-host';
import { presentModal } from './overlays/load.js';
import { iconMarkup, PERMISSION_ICONS } from './permission-icons.js';
import type { ModalButton } from './state/modals.js';

function formatSize(bytes: bigint): string {
  return bytes >= 1024n && bytes % 1024n === 0n ? `${String(bytes / 1024n)} KiB` : `${String(bytes)} bytes`;
}

export async function showPreimageSubmitModal(
  review: PreimageSubmitReview,
  signal?: AbortSignal,
  allowAutomatic = true,
): Promise<PermissionDecision> {
  const buttons: ModalButton<PermissionDecision>[] = [{ label: 'Deny', variant: 'danger', result: 'Deny' }];
  if (allowAutomatic) {
    buttons.push({ label: 'Allow bounded automatic uploads', variant: 'secondary', result: 'AllowAlways' });
  }
  buttons.push({ label: 'Allow once', variant: 'primary', result: 'AllowOnce' });
  const { result } = await presentModal<PermissionDecision>(
    {
      icon: iconMarkup(PERMISSION_ICONS.PreimageSubmit),
      title: 'Submit Preimage',
      fields: [
        { label: 'Product', value: review.productId },
        { label: 'Root account', value: review.rootPublicKey, mono: true },
        { label: 'Bulletin network (genesis)', value: review.genesisHash, mono: true },
        { label: 'Data size', value: formatSize(review.size) },
        ...(allowAutomatic
          ? [
              {
                label: 'Separate automatic upload consent',
                value: `Up to ${formatSize(review.automaticMaxBytes)} per upload, ${String(review.automaticMaxUploads)} automatic uploads per rolling ${String(review.automaticWindowSeconds)} seconds. Only for this product, root account and Bulletin network.`,
              },
            ]
          : []),
      ],
      notice: allowAutomatic
        ? 'Allow once approves only this upload. Larger uploads or an exhausted budget always ask again. Revoke automatic uploads in Permissions; revoking or granting again does not reset the rolling budget. Signing permission does not authorize uploads.'
        : 'This approves only this upload, without granting automatic upload consent.',
      noticeIcon: 'info',
      buttons,
      dismissOnBackdrop: false,
      fallbackResult: 'Deny',
    },
    signal,
  );
  return result;
}
