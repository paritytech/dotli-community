// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A granted list denies whatever it leaves out, and product pages reach the dev store on the root origin over loopback,
// which Chrome's local network access asks for.
export const BROWSER_PERMISSIONS = [
  'local-network-access',
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'clipboard-read',
  'clipboard-write',
] as const;
