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

/** The kinds of read a name list sync measures. */
type NameListReadKind = 'label_stores' | 'new_labels' | 'app_labels';

/** Every kind of read a name list sync measures. */
export const NAME_LIST_READ_KINDS: readonly NameListReadKind[] = ['label_stores', 'new_labels', 'app_labels'];

/** The `detail` of one read's measure. */
export type NameListReadDetail = {
  kind: NameListReadKind;
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

/** Every backend a summary may name. */
const SUMMARY_BACKENDS = {
  'smoldot-direct': true,
  'smoldot-shared-worker': true,
  'rpc-gateway': true,
} satisfies Record<Backend, true>;

/** Whether a value read back from a sync's end mark is a `NameListSyncSummary`. */
export function isNameListSyncSummary(value: unknown): value is NameListSyncSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    'outcome' in value &&
    isOutcome(value.outcome) &&
    'reason' in value &&
    (value.reason === null || typeof value.reason === 'string') &&
    'backend' in value &&
    typeof value.backend === 'string' &&
    Object.hasOwn(SUMMARY_BACKENDS, value.backend) &&
    'start' in value &&
    (value.start === 'cold' || value.start === 'stored') &&
    'stores' in value &&
    typeof value.stores === 'number' &&
    'entries' in value &&
    typeof value.entries === 'number' &&
    'labels' in value &&
    typeof value.labels === 'number' &&
    'apps' in value &&
    typeof value.apps === 'number' &&
    'reads' in value &&
    typeof value.reads === 'number'
  );
}

/** Whether a value read back from a read's measure is a `NameListReadDetail`. */
export function isNameListReadDetail(value: unknown): value is NameListReadDetail {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    NAME_LIST_READ_KINDS.some(kind => kind === value.kind) &&
    'outcome' in value &&
    isOutcome(value.outcome) &&
    'items' in value &&
    typeof value.items === 'number' &&
    'found' in value &&
    typeof value.found === 'number'
  );
}

function isOutcome(value: unknown): value is 'ok' | 'error' {
  return value === 'ok' || value === 'error';
}
