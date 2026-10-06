// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { withActiveTld } from '@dotli/config';
import { CALLING_ICON, iconMarkup, JAM_PEERS_ICON, PERMISSION_ICONS } from './permission-icons.js';
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
// StatementSubmit), plus JAM peer access (`JamPeers`), which names the JAM
// network it covers. `OpenUrl` is auto-granted at the container level and
// never reaches this modal.
// Returns an explicit decision so callers can distinguish "Deny" from
// dismissing the dialog without storing a denial. With `allowOnce`, the prompt
// also offers a one-time grant and highlights it over "Always allow".
//
// Rendered by the overlays root (components/entities/PromptDialog.tsx).

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
  ProfileDisclosure:
    "Share this app's profile with app audiences or selected contacts, including personal sharing across recipients' apps",
  ChainSubmit: 'Sign and submit on-chain transactions on your behalf',
  PreimageSubmit: 'Store preimage data on-chain via the Bulletin network',
  StatementSubmit: 'Submit signed statements to the statement store',
};

/** What a host Media consent prompt promises: the product never gets raw capture. */
export const MEDIA_CONSENT_NOTICE =
  'Only the trusted host handles call media. The application receives no camera, microphone, screen pixels, or raw browser capture permission.';

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

export type PermissionPromptDecision = 'granted' | 'granted-once' | 'denied' | 'dismissed';

export interface PermissionRequestModalOptions {
  /** Offer "Allow once" alongside "Always allow" and "Deny". */
  allowOnce?: boolean;
  /**
   * Trusted host Media consent: the exact product id and scope fields. Media
   * consent never reloads the product or grants it raw capture.
   */
  media?: { productId: string; fields: readonly (readonly [string, string])[] };
}

/**
 * Show a permission request modal.
 */
export async function showPermissionRequestModal(
  label: string,
  permission: EnforceablePermissionName | 'Calling',
  signal?: AbortSignal,
  options: PermissionRequestModalOptions = {},
): Promise<PermissionPromptDecision> {
  return showPermissionPrompt(
    label,
    {
      icon: iconMarkup(permission === 'Calling' ? CALLING_ICON : PERMISSION_ICONS[permission]),
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
      icon: prompt.icon,
      title: 'Permission Request',
      fields: [
        { label: 'Application', value: media?.productId ?? withActiveTld(label) },
        { label: 'Permission', value: prompt.description },
        ...(prompt.detail === undefined ? [] : [{ label: 'JAM network genesis', value: prompt.detail, mono: true }]),
        ...(media?.fields ?? []).map(([fieldLabel, value]) => ({ label: fieldLabel, value, mono: true })),
      ],
      ...(media !== undefined
        ? { notice: MEDIA_CONSENT_NOTICE, noticeIcon: 'info' as const }
        : prompt.reloads
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
