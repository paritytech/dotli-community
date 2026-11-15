// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatBigInt } from './formatBigInt.js';
import { formatHexPreview } from './formatHexPreview.js';
import { isUint8ArrayLike } from './isUint8ArrayLike.js';
import { toEnumValue, toRecord } from './shape.js';

/** A payload as one short line for its row, at most a few keys and 80 characters. Never throws. */
export function formatPayloadSummary(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return '';
  }
  if (isUint8ArrayLike(payload)) {
    return `bytes[${String(payload.length)}] ${formatHexPreview(payload, 8)}`;
  }
  const record = toRecord(payload);
  if (record === undefined) {
    return truncateText(stringifyPrimitive(payload), 80);
  }
  const entries = Object.entries(record);
  const shown = entries.slice(0, 3);
  const parts = shown.map(([key, value]) => `${key}=${formatInline(value)}`);
  if (entries.length > shown.length) {
    parts.push('…');
  }
  return truncateText(parts.join(' '), 80);
}

/** A field's value, in fewer characters than a whole payload gets. */
function formatInline(value: unknown): string {
  if (isUint8ArrayLike(value)) {
    return `bytes[${String(value.length)}]`;
  }
  if (typeof value === 'string') {
    return `"${truncateText(value, 24)}"`;
  }
  const record = toRecord(value);
  return record === undefined ? stringifyPrimitive(value) : formatRecordShape(record);
}

/** A record as its enum tag when it is a `{ tag, value }` pair, else as its key count, empty or not. */
function formatRecordShape(record: Record<string, unknown>): string {
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return '{}';
  }
  const enumValue = toEnumValue(record);
  if (keys.length === 2 && enumValue !== undefined && 'value' in record) {
    return `{${enumValue.tag}}`;
  }
  return `{${String(keys.length)} keys}`;
}

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** Refuses to fall back to `[object Object]`. */
function stringifyPrimitive(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undef';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'bigint') {
    return formatBigInt(value);
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  return '?';
}
