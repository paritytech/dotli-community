// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getErrorChain } from '@dotli/shared';

/** The event extras for a thrown value that is not an `Error`: the raw value and its cause chain. */
export function getNonErrorExtra(thrown: unknown): Record<string, unknown> {
  return { rawThrown: thrown, errorChain: getErrorChain(thrown) };
}
