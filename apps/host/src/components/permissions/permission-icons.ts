// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Component } from 'solid-js';
import { BellIcon, type IconProps } from '@dotli/ui/icons';
import { BiometricsIcon } from '../icons/BiometricsIcon.js';
import { BluetoothIcon } from '../icons/BluetoothIcon.js';
import { CameraIcon } from '../icons/CameraIcon.js';
import { ClipboardIcon } from '../icons/ClipboardIcon.js';
import { IdentityIcon } from '../icons/IdentityIcon.js';
import { LocationIcon } from '../icons/LocationIcon.js';
import { MicrophoneIcon } from '../icons/MicrophoneIcon.js';
import { NfcIcon } from '../icons/NfcIcon.js';
import { SignIcon } from '../icons/SignIcon.js';
import { StatementIcon } from '../icons/StatementIcon.js';
import { UploadIcon } from '../icons/UploadIcon.js';
import type { EnforceablePermissionName } from '../../runtime/permissions.js';

const PERMISSION_ICONS: Readonly<Record<EnforceablePermissionName, Component<IconProps>>> = {
  Notifications: BellIcon,
  Camera: CameraIcon,
  Microphone: MicrophoneIcon,
  Location: LocationIcon,
  Bluetooth: BluetoothIcon,
  NFC: NfcIcon,
  Clipboard: ClipboardIcon,
  Biometrics: BiometricsIcon,
  IdentityDisclosure: IdentityIcon,
  ChainSubmit: SignIcon,
  PreimageSubmit: UploadIcon,
  StatementSubmit: StatementIcon,
};

/** A permission's icon. Unsized, as a dialog's icon tile or the row's stylesheet sizes it. */
export function permissionIcon(name: EnforceablePermissionName): Component<IconProps> {
  return PERMISSION_ICONS[name];
}
