// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The permissions as the row reads them. Callers pass wider values, which fit structurally.

/** A permission an app can be granted, by the runtime's name. */
export type PermissionName =
  | 'Notifications'
  | 'Camera'
  | 'Microphone'
  | 'Location'
  | 'Bluetooth'
  | 'NFC'
  | 'Clipboard'
  | 'Biometrics'
  | 'IdentityDisclosure'
  | 'ChainSubmit'
  | 'PreimageSubmit'
  | 'StatementSubmit';

export type PermissionStatus = 'ask' | 'granted' | 'denied';

/** One permission as its row shows it. */
export interface PermissionEntry {
  name: PermissionName;
  label: string;
}
