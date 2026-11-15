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

/** How each field of a summary is checked. Every check rejects `undefined`, so a missing field fails it. */
const SUMMARY_FIELD_CHECKS = {
  outcome: isOutcome,
  reason: value => value === null || typeof value === 'string',
  backend: value => typeof value === 'string' && Object.hasOwn(SUMMARY_BACKENDS, value),
  start: value => value === 'cold' || value === 'stored',
  stores: isCount,
  entries: isCount,
  labels: isCount,
  apps: isCount,
  reads: isCount,
} satisfies Record<keyof NameListSyncSummary, (value: unknown) => boolean>;

/** How each field of a read detail is checked. Every check rejects `undefined`, so a missing field fails it. */
const READ_DETAIL_FIELD_CHECKS = {
  kind: value => NAME_LIST_READ_KINDS.some(kind => kind === value),
  outcome: isOutcome,
  items: isCount,
  found: isCount,
} satisfies Record<keyof NameListReadDetail, (value: unknown) => boolean>;

/** Whether a value read back from a sync's end mark is a `NameListSyncSummary`. */
export function isNameListSyncSummary(value: unknown): value is NameListSyncSummary {
  return passesFieldChecks(value, SUMMARY_FIELD_CHECKS);
}

/** Whether a value read back from a read's measure is a `NameListReadDetail`. */
export function isNameListReadDetail(value: unknown): value is NameListReadDetail {
  return passesFieldChecks(value, READ_DETAIL_FIELD_CHECKS);
}

/** Whether `value` is an object whose every field passes its check in `checks`. */
function passesFieldChecks(value: unknown, checks: Record<string, (field: unknown) => boolean>): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.entries(checks).every(([field, check]) => check(Reflect.get(value, field)))
  );
}

function isOutcome(value: unknown): value is 'ok' | 'error' {
  return value === 'ok' || value === 'error';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number';
}
