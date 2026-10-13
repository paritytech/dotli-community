// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModalView } from '@dotli/ui-core';
import { permissionIcon, type PermissionName } from '@dotli/ui-entities';

const PERMISSION_DESCRIPTIONS: Record<PermissionName, string> = {
  Notifications: 'Show in-app and system notifications',
  Camera: 'Access your camera for photo and video capture',
  Microphone: 'Access your microphone for audio input',
  Location: 'Access your location for geolocation services',
  Bluetooth: 'Connect to nearby Bluetooth devices',
  NFC: 'Read and write nearby NFC tags',
  Clipboard: 'Read text and data from your clipboard',
  Biometrics: 'Authenticate with a platform passkey or biometric prompt',
  IdentityDisclosure: 'Share your primary DotNS identity with this app',
  ChainSubmit: 'Sign and submit network transactions on your behalf',
  PreimageSubmit: 'Store preimage data on the Bulletin network',
  StatementSubmit: 'Submit signed statements to the statement store',
};

/** `dismissed` stays apart from `denied` so a dismissal stores no denial. */
export type PermissionDecision = 'granted' | 'granted-once' | 'denied' | 'dismissed';

export interface PermissionRequest {
  /** The app's name as the user reads it. */
  app: string;
  permission: PermissionName;
  /** Offers a one-time grant beside the lasting one. */
  allowOnce: boolean;
  /** Granting rebuilds the app's frame, so the dialog says the app reloads. */
  reloads: boolean;
}

/** The dialog an app's request for a permission asks the user with. */
export function permissionRequestDialog(request: PermissionRequest): ModalView<PermissionDecision> {
  const buttons: ModalView<PermissionDecision>['buttons'] = [
    { label: 'Deny', variant: 'danger', result: 'denied' },
    request.allowOnce
      ? { label: 'Always allow', variant: 'secondary', result: 'granted' }
      : { label: 'Allow', variant: 'primary', result: 'granted' },
  ];
  if (request.allowOnce) {
    buttons.push({
      label: 'Allow once',
      variant: 'primary',
      result: 'granted-once',
    });
  }
  return {
    icon: permissionIcon(request.permission),
    title: 'Permission Request',
    fields: [
      { label: 'Application', value: request.app },
      { label: 'Permission', value: PERMISSION_DESCRIPTIONS[request.permission] },
    ],
    ...(request.reloads ? { notice: 'Granting this permission will reload the application.' } : {}),
    buttons,
    dismissOnBackdrop: true,
    dismissResult: 'dismissed',
    fallbackResult: 'dismissed',
  };
}
