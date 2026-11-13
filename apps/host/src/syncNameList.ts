// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Brings the landing page's dotNS name list up to date in steps, saving after each one, so a visit cut short keeps the
// progress it made and the next one goes on from there.

import type { Network } from '@dotli/config';
import type { DotnsResolver } from '@dotli/resolver';
import type { NameListRecord } from '@dotli/storage';

/** The reads a sync needs, which the resolver provides. */
export type NameListReads = Pick<DotnsResolver, 'readLabelStores' | 'readNewLabels' | 'readAppLabels'>;

type Params = {
  /** What the last sync saved, or `null` on a first visit. */
  stored: NameListRecord | null;
  network: Network;
  reads: NameListReads;
  /** Saves a record. Called after each step that changed it, and awaited before the next step starts. */
  save: (record: NameListRecord) => Promise<void>;
  now?: () => number;
};

const STORE_CHUNK = 16;
const RECHECK_CHUNK = 256;
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Brings `stored` up to date and resolves the final record, `stored` itself when nothing changed. It saves after each
 * step that changed the record. A new store with no entries yet is in the resolved record, but is saved only once an
 * entry moves its cursor. It rejects with the read's error after the steps before it were saved.
 */
export async function syncNameList({ stored, network, reads, save, now = Date.now }: Params): Promise<NameListRecord> {
  let record: NameListRecord = stored ?? { network, stores: [], apps: [], pending: [] };

  const added = await reads.readLabelStores(record.stores.length);
  if (added.length > 0) {
    record = { ...record, stores: [...record.stores, ...added.map(address => ({ address, read: 0 }))] };
  }

  for (let start = 0; start < record.stores.length; start += STORE_CHUNK) {
    // A read takes a slice of each store's new entries, so the chunk is read again until no cursor moves.
    for (;;) {
      const chunk = record.stores.slice(start, start + STORE_CHUNK);
      const { stores, labels } = await reads.readNewLabels(chunk);
      // Labels come only from entries past a cursor, so a read that moved none found none.
      if (stores.every((store, index) => store.read === chunk[index]?.read)) {
        break;
      }
      const known = new Set([...record.apps, ...record.pending.map(p => p.label)]);
      const fresh = labels.filter(label => !known.has(label));
      const withApp = await reads.readAppLabels(fresh);
      const checkedAt = now();
      record = {
        ...record,
        stores: [...record.stores.slice(0, start), ...stores, ...record.stores.slice(start + STORE_CHUNK)],
        apps: [...record.apps, ...fresh.filter(label => withApp.has(label))],
        pending: [
          ...record.pending,
          ...fresh.filter(label => !withApp.has(label)).map(label => ({ label, checkedAt })),
        ],
      };
      await save(record);
    }
  }

  const staleBefore = now() - RECHECK_AFTER_MS;
  const stale = record.pending.filter(p => p.checkedAt < staleBefore).map(p => p.label);
  for (let start = 0; start < stale.length; start += RECHECK_CHUNK) {
    const chunk = new Set(stale.slice(start, start + RECHECK_CHUNK));
    const withApp = await reads.readAppLabels([...chunk]);
    const checkedAt = now();
    record = {
      ...record,
      apps: [...record.apps, ...[...chunk].filter(label => withApp.has(label))],
      pending: record.pending.flatMap(p => {
        if (!chunk.has(p.label)) {
          return [p];
        }
        return withApp.has(p.label) ? [] : [{ label: p.label, checkedAt }];
      }),
    };
    await save(record);
  }

  return record;
}
