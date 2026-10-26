// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The local roots, which the local servers answer under and a page takes for the root domain. It imports nothing, so a
// page, a build config and a script Node runs directly all load it.

/** The loopback name, which every build takes for the root domain. */
export const LOOPBACK_ROOT = 'localhost';

/** The roots a local server answers under, each standing for the root domain. */
export const LOCAL_ROOTS: readonly string[] = [LOOPBACK_ROOT, 'local.host'];

/**
 * The local roots a page of this build takes for the root domain. `local.host` is a public name that reaches this
 * machine only while its owner points it here, so only a development build trusts it.
 */
export function trustedLocalRoots(dev: boolean): readonly string[] {
  return dev ? LOCAL_ROOTS : [LOOPBACK_ROOT];
}
