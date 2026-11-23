// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isRecord } from '@dotli/shared';

/** A value the VM threw, as dumped to the host, as `"<name>: <message>"` when it is an error, or as text otherwise. */
export function getVmErrorMessage(dumped: unknown): string {
  if (isRecord(dumped) && typeof dumped['message'] === 'string') {
    return typeof dumped['name'] === 'string' ? `${dumped['name']}: ${dumped['message']}` : dumped['message'];
  }
  return typeof dumped === 'object' && dumped !== null ? JSON.stringify(dumped) : String(dumped);
}
