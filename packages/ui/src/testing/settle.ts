// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { flush } from 'solid-js';

/** Solid 2 batches writes, so assertions after an event or a store write come after this. */
export async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
}
