// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { withActiveTld } from '@dotli/config';
import { iconMarkup, PERMISSION_ICONS } from './permission-icons.js';
import { isDevicePermission, type EnforceablePermissionName } from './permissions.js';
import { presentModal } from './overlays/load.js';
import type { ModalButton } from './state/modals.js';

export const PERMISSION_DESCRIPTIONS: Record<EnforceablePermissionName | 'Calling', string> = {
  Calling: 'Make and receive encrypted calls for this account and network',
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
  ChainSubmit: 'Sign and submit network transactions on your behalf',
  PreimageSubmit: 'Store preimage data on the Bulletin network',
  StatementSubmit: 'Submit signed statements to the statement store',
};

/** `dismissed` stays apart from `denied` so a dismissal stores no denial. */
export type PermissionPromptDecision = 'granted' | 'granted-once' | 'denied' | 'dismissed';

export interface PermissionRequestModalOptions {
  allowOnce?: boolean;
  /**
   * Trusted host Media consent: the exact product id and scope fields. Media
   * consent never reloads the product or grants it raw capture.
   */
  media?: { productId: string; fields: readonly (readonly [string, string])[] };
}

export async function showPermissionRequestModal(
  label: string,
  permission: EnforceablePermissionName | 'Calling',
  signal?: AbortSignal,
  options: PermissionRequestModalOptions = {},
): Promise<PermissionPromptDecision> {
  const allowOnce = options.allowOnce === true;
  const media = options.media;
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
        { label: 'Application', value: media?.productId ?? withActiveTld(label) },
        { label: 'Permission', value: PERMISSION_DESCRIPTIONS[permission] },
        ...(media?.fields ?? []).map(([fieldLabel, value]) => ({ label: fieldLabel, value, mono: true })),
      ],
      ...(media !== undefined
        ? {
            notice:
              'Only the trusted host handles call media. The application receives no camera, microphone, screen pixels, or raw browser capture permission.',
          }
        : permission !== 'Calling' && isDevicePermission(permission) && !allowOnce
          ? { notice: 'Granting this permission will reload the application.' }
          : {}),
      buttons,
      dismissOnBackdrop: true,
      dismissResult: 'dismissed',
      fallbackResult: 'dismissed',
    },
    signal,
  );
  return result;
}
