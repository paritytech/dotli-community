// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a landing name list sync writes to the page's performance timeline, for whoever reads it from outside the page.
// Type imports only, so a Node loader with no bundler can import it.

import type { Backend } from '@dotli/config';

/** The marks one name list sync writes to the page's performance timeline. */
export const NAME_LIST_MARKS = {
  start: 'dotli:name-list:start',
  stored: 'dotli:name-list:stored',
  reads: 'dotli:name-list:reads',
  labels: 'dotli:name-list:labels',
  end: 'dotli:name-list:end',
} as const;

/** The measure of one resolver read of a name list sync. */
export const NAME_LIST_READ_MEASURE = 'dotli:name-list:read';

/** The `detail` of one read's measure. */
export type NameListReadDetail = {
  kind: 'label_stores' | 'new_labels' | 'app_labels';
  outcome: 'ok' | 'error';
  /** Stores known before the read, stores asked, or labels checked. */
  items: number;
  /** Stores added, entries read, or labels with an app. Zero on an error. */
  found: number;
};

/** The `detail` of a sync's end mark. */
export type NameListSyncSummary = {
  outcome: 'ok' | 'error';
  /** The error's name, null on `ok`. */
  reason: string | null;
  backend: Backend;
  start: 'cold' | 'stored';
  /** Label stores known after the sync, the stored ones included. */
  stores: number;
  /** Store entries this sync read. */
  entries: number;
  /** New labels this sync found. */
  labels: number;
  /** Labels this sync found with an app. */
  apps: number;
  /** Resolver reads this sync measured. */
  reads: number;
};
