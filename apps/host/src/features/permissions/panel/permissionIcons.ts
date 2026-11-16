// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Component } from 'solid-js';
import { BellIcon, type IconProps } from '@dotli/ui/icons';
import { BiometricsIcon } from './BiometricsIcon.js';
import { BluetoothIcon } from './BluetoothIcon.js';
import { CameraIcon } from './CameraIcon.js';
import { ClipboardIcon } from './ClipboardIcon.js';
import { IdentityIcon } from './IdentityIcon.js';
import { LocationIcon } from './LocationIcon.js';
import { MicrophoneIcon } from './MicrophoneIcon.js';
import { MotionIcon } from './MotionIcon.js';
import { NfcIcon } from './NfcIcon.js';
import { SignIcon } from './SignIcon.js';
import { StatementIcon } from './StatementIcon.js';
import { UploadIcon } from './UploadIcon.js';
import type { EnforceablePermissionName } from '../policy/permissionPolicy.js';

const PERMISSION_ICONS: Readonly<Record<EnforceablePermissionName, Component<IconProps>>> = {
  Notifications: BellIcon,
  Camera: CameraIcon,
  Microphone: MicrophoneIcon,
  Location: LocationIcon,
  Motion: MotionIcon,
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
