// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { withActiveTld } from '@dotli/config';
import { iconMarkup, JAM_PEERS_ICON, PERMISSION_ICONS } from './permission-icons.js';
import { isDevicePermission, type EnforceablePermissionName } from './permissions.js';
import { presentModal } from './overlays/load.js';
import type { ModalButton } from './state/modals.js';

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
  ProfileDisclosure:
    "Share this app's profile with app audiences or selected contacts, including personal sharing across recipients' apps",
  ChainSubmit: 'Sign and submit network transactions on your behalf',
  PreimageSubmit: 'Store preimage data on the Bulletin network',
  StatementSubmit: 'Submit signed statements to the statement store',
};

/** The question asked before an app may reach the validators of one JAM network. */
export function jamPeersPermissionText(label: string, genesis: string): string {
  return `Allow ${withActiveTld(label)} to connect to JAM network ${genesis.slice(0, 10)}… (read-only peer access, no accounts or signing)?`;
}

interface PermissionPrompt {
  icon: string;
  description: string;
  /** Full network identity, displayed separately from the abbreviated question. */
  detail?: string;
  /** Granting reloads the application (iframe `allow`-gated permissions). */
  reloads: boolean;
}

/** `dismissed` stays apart from `denied` so a dismissal stores no denial. */
export type PermissionPromptDecision = 'granted' | 'granted-once' | 'denied' | 'dismissed';

export interface PermissionRequestModalOptions {
  allowOnce?: boolean;
}

export async function showPermissionRequestModal(
  label: string,
  permission: EnforceablePermissionName,
  signal?: AbortSignal,
  options: PermissionRequestModalOptions = {},
): Promise<PermissionPromptDecision> {
  return showPermissionPrompt(
    label,
    {
      icon: iconMarkup(PERMISSION_ICONS[permission]),
      description: PERMISSION_DESCRIPTIONS[permission],
      reloads: isDevicePermission(permission),
    },
    signal,
    options,
  );
}

/** The shared Solid dialog asks for a grant scoped to this product and genesis. */
export function showJamPeersPermissionModal(
  label: string,
  genesis: string,
  signal?: AbortSignal,
): Promise<PermissionPromptDecision> {
  return showPermissionPrompt(
    label,
    {
      icon: iconMarkup(JAM_PEERS_ICON),
      description: jamPeersPermissionText(label, genesis),
      detail: genesis,
      reloads: false,
    },
    signal,
    { allowOnce: true },
  );
}

async function showPermissionPrompt(
  label: string,
  prompt: PermissionPrompt,
  signal: AbortSignal | undefined,
  options: PermissionRequestModalOptions,
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
      icon: prompt.icon,
      title: 'Permission Request',
      fields: [
        { label: 'Application', value: withActiveTld(label) },
        { label: 'Permission', value: prompt.description },
        ...(prompt.detail === undefined ? [] : [{ label: 'JAM network genesis', value: prompt.detail, mono: true }]),
      ],
      ...(prompt.reloads ? { notice: 'Granting this permission will reload the application.' } : {}),
      buttons,
      dismissOnBackdrop: true,
      dismissResult: 'dismissed',
      fallbackResult: 'dismissed',
    },
    signal,
  );
  return result;
}
