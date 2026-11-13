// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A build-time define, so undefined in tests and other bundles.
declare const __DOTLI_VERSION__: string | undefined;

/** The release the build descends from, or null in a build that names none. */
export const DOTLI_VERSION = typeof __DOTLI_VERSION__ === 'string' ? __DOTLI_VERSION__ : null;

/** The release the build descends from, or `0.0.0` in a build that names none. */
export function getDotliVersion(): string {
  return DOTLI_VERSION ?? '0.0.0';
}
