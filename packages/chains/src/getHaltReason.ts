// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no value, so a caller on an eager path can take this module without the rest of the package.

import type { RemoteChainHalt } from './chainHaltError.js';

/**
 * Why a halt happened. Anything but a `ChainHaltError` is the chain's own halt. Matched by name to read errors from
 * another realm.
 */
export function getHaltReason(error: unknown): RemoteChainHalt {
  const isHaltError = error instanceof Error && error.name === 'ChainHaltError';
  return isHaltError && 'reason' in error && error.reason === 'frame' ? 'frame' : 'chain';
}
