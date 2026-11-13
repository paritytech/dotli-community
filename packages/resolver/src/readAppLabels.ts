// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A label has an app when its `app.<label>.<tld>` name has a contenthash. Only the contenthash's base slot is read: a
// non-empty one is enough, so the data slots of a long value are never read.

import type { DotnsContracts } from '@dotli/config';
import type { Api } from './createRawApi.js';
import { computeMappingSlot, computeNamehash, decodeBytesSlot } from './storageSlots.js';

type Params = {
  api: Api;
  dotns: DotnsContracts;
  labels: readonly string[];
};

/** The labels whose `app.<label>.<tld>` has a contenthash, read in one block. Rejects with a slot read's error. */
export async function readAppLabels({ api, dotns, labels }: Params): Promise<Set<string>> {
  if (labels.length === 0) {
    return new Set();
  }
  const slots = labels.map(label => ({
    label,
    slotKey: computeMappingSlot(computeNamehash(`app.${label}.${dotns.TLD}`), dotns.STORAGE_SLOTS.CONTENTHASH),
  }));
  const words = await api.withBestBlock(atHash =>
    api.readSlots(
      dotns.DOTNS_CONTENT_RESOLVER,
      slots.map(({ slotKey }) => slotKey),
      { atHash },
    ),
  );
  const appLabels = new Set<string>();
  for (const [index, { label, slotKey }] of slots.entries()) {
    const word = words[index] ?? null;
    if (word !== null && decodeBytesSlot(word, slotKey) !== null) {
      appLabels.add(label);
    }
  }
  return appLabels;
}
