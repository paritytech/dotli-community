// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type EnumValue = {
  tag: string;
  value: unknown;
};

const VERSION_TAG = /^[vV]\d+$/;

/** Unwrap one `{tag: "V1", value}` version envelope, leaving other payloads untouched. */
export function peelVersion(value: unknown): unknown {
  const record = toRecord(value);
  if (record === undefined) {
    return value;
  }
  if (typeof record['tag'] === 'string' && VERSION_TAG.test(record['tag']) && 'value' in record) {
    return record['value'];
  }
  return value;
}

/** `value` as a record when it is a non-null object, else undefined. Never throws. */
export function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null) {
    // The payload parse is held, so an array or a class instance reads as a record of its own keys.
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** `value` as a `{ tag, value }` enum when it has a string tag, else undefined. Never throws. */
export function toEnumValue(value: unknown): EnumValue | undefined {
  const record = toRecord(value);
  if (record === undefined) {
    return undefined;
  }
  if (typeof record['tag'] !== 'string') {
    return undefined;
  }
  return { tag: record['tag'], value: record['value'] };
}

/** `value` when it is a string, else undefined. Never throws. */
export function toStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
