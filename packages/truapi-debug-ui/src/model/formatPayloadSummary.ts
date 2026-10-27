// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatBigInt } from './formatBigInt.js';
import { formatHexPreview } from './formatHexPreview.js';
import { isUint8ArrayLike } from './isUint8ArrayLike.js';
import { toRecord } from './shape.js';

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
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (parts.length >= 3) {
      parts.push('…');
      break;
    }
    parts.push(`${key}=${formatInline(value)}`);
  }
  return truncateText(parts.join(' '), 80);
}

function formatInline(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undef';
  }
  if (isUint8ArrayLike(value)) {
    return `bytes[${String(value.length)}]`;
  }
  if (typeof value === 'bigint') {
    return formatBigInt(value);
  }
  if (typeof value === 'string') {
    return `"${truncateText(value, 24)}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const record = toRecord(value);
  if (record === undefined) {
    return '?';
  }
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return '{}';
  }
  if (keys.length === 2 && 'tag' in record && 'value' in record) {
    return `{${stringifyPrimitive(record['tag'])}}`;
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
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  return '?';
}
