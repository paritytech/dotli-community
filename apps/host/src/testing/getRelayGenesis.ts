// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getActiveChainRoles } from '@dotli/config';
import { must } from '@dotli/shared/testing';

/** Returns the genesis of the active network's relay. Throws when the active network has no relay. */
export function getRelayGenesis(): string {
  return must(
    getActiveChainRoles().find(role => role.role === 'relay'),
    'relay',
  ).genesis;
}
