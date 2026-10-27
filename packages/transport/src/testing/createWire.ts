// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A rig over the vault schema that keeps the bytes it carried.

import { createTransport } from '../createTransport.js';
import { createProviderPair } from '../provider.fake.js';
import { vaultSchema } from './vaultSchema.js';

/**
 * Connects an opener and an accepter of `vaultSchema` over one in-memory channel, with every message either side
 * received.
 */
export function createWire() {
  const { left, right, delivered } = createProviderPair();
  const accepter = createTransport({ schema: vaultSchema, provider: right, handshake: 'respond', hello: 'accepter' });
  const opener = createTransport({ schema: vaultSchema, provider: left, handshake: 'offer', hello: 'opener' });
  opener.connect();
  return { opener, accepter, delivered };
}
