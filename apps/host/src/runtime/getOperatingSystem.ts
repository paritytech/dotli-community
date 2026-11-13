// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type OperatingSystem = 'iOS' | 'Android' | 'macOS' | 'Windows' | 'Linux' | 'Unknown';

/**
 * The operating system `userAgent` names. An iPhone's says "like Mac OS X" and an Android's says "Linux", so each is
 * told apart before the desktop system it also names. Never throws.
 */
export function getOperatingSystem(userAgent: string): OperatingSystem {
  if (userAgent.includes('iPhone') || userAgent.includes('iPad')) {
    return 'iOS';
  }
  if (userAgent.includes('Android')) {
    return 'Android';
  }
  if (userAgent.includes('Mac OS X') || userAgent.includes('Macintosh')) {
    return 'macOS';
  }
  if (userAgent.includes('Windows')) {
    return 'Windows';
  }
  if (userAgent.includes('Linux')) {
    return 'Linux';
  }
  return 'Unknown';
}
