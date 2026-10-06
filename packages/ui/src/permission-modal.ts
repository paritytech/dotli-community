// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { withActiveTld } from '@dotli/config';
import { iconMarkup, PERMISSION_ICONS } from './permission-icons.js';
import { isDevicePermission, type EnforceablePermissionName } from './permissions.js';
import { presentModal } from './overlays/load.js';
import type { ModalButton } from './state/modals.js';

// dot.li Permission request modal
//
// Shows a confirmation dialog when a product requests a permission the
// host can actually gate: the Permissions-Policy-backed device
// variants (Camera, Microphone, Location, Bluetooth, NFC, Clipboard,
// Biometrics, Notifications), Chat identity authority, identity disclosure,
// and the internal submitted gates (ChainSubmit, PreimageSubmit,
// StatementSubmit). `OpenUrl` is auto-granted at the container level and never
// reaches this modal.
// Returns an explicit decision so callers can distinguish "Deny" from
// dismissing the dialog without storing a denial. With `allowOnce`, the prompt
// also offers a one-time grant and highlights it over "Always allow".
//
// Rendered by the overlays root (components/entities/PromptDialog.tsx).

export const PERMISSION_DESCRIPTIONS: Record<EnforceablePermissionName, string> = {
  Notifications: 'Show in-app and system notifications',
  Camera: 'Access your camera for photo and video capture',
  Microphone: 'Access your microphone for audio input',
  Location: 'Access your location for geolocation services',
  Bluetooth: 'Connect to nearby Bluetooth devices',
  NFC: 'Read and write nearby NFC tags',
  Clipboard: 'Read text and data from your clipboard',
  Biometrics: 'Authenticate with a platform passkey or biometric prompt',
  ChatAuthority: "Bind this app's device account to your wallet Chat identity and encrypt or decrypt Chat routing data",
  IdentityDisclosure: 'Share your primary DotNS identity with this app',
  ChainSubmit: 'Sign and submit on-chain transactions on your behalf',
  PreimageSubmit: 'Store preimage data on-chain via the Bulletin network',
  StatementSubmit: 'Submit signed statements to the statement store',
};

export type PermissionPromptDecision = 'granted' | 'granted-once' | 'denied' | 'dismissed';

export interface PermissionRequestModalOptions {
  /** Offer "Allow once" alongside "Always allow" and "Deny". */
  allowOnce?: boolean;
}

/**
 * Show a permission request modal.
 */
export async function showPermissionRequestModal(
  label: string,
  permission: EnforceablePermissionName,
  signal?: AbortSignal,
  options: PermissionRequestModalOptions = {},
): Promise<PermissionPromptDecision> {
  const allowOnce = options.allowOnce === true;
  const buttons: ModalButton<PermissionPromptDecision>[] = [
    { label: 'Deny', variant: 'danger', result: 'denied' },
    allowOnce
      ? { label: 'Always allow', variant: 'secondary', result: 'granted' }
      : { label: 'Allow', variant: 'primary', result: 'granted' },
  ];
  if (allowOnce) {
    buttons.push({
      label: 'Allow once',
      variant: 'primary',
      result: 'granted-once',
    });
  }
  const { result } = await presentModal<PermissionPromptDecision>(
    {
      icon: iconMarkup(PERMISSION_ICONS[permission]),
      title: 'Permission Request',
      fields: [
        { label: 'Application', value: withActiveTld(label) },
        { label: 'Permission', value: PERMISSION_DESCRIPTIONS[permission] },
      ],
      ...(isDevicePermission(permission) ? { notice: 'Granting this permission will reload the application.' } : {}),
      buttons,
      dismissOnBackdrop: true,
      dismissResult: 'dismissed',
      fallbackResult: 'dismissed',
    },
    signal,
  );
  return result;
}
