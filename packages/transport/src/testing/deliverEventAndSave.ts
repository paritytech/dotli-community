// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { ok } from '../result.js';
import { createWire } from './createWire.js';
import { vaultSchema } from './vaultSchema.js';

const { save, events } = vaultSchema.sections.vault;

/** Runs an opener that hears one event and saves once, and returns every message either side received. */
export async function deliverEventAndSave(): Promise<Uint8Array[]> {
  const { opener, accepter, delivered } = createWire();
  accepter.handleSubscription(events, (_start, _context, sink) => {
    sink.send('synced');
    return () => undefined;
  });
  accepter.handleRequest(save, () => ok());
  await new Promise<void>(resolve => {
    opener.subscribe({
      method: events,
      start: undefined,
      listeners: {
        receive: () => {
          resolve();
        },
        interrupt: () => undefined,
        fail: () => undefined,
        close: () => undefined,
      },
    });
  });
  await opener.request(save, { entropy: new Uint8Array([1, 2, 255]), amount: 2n ** 100n });
  return delivered;
}
