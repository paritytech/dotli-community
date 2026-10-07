// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { toHex } from '@dotli/shared';

const MAX_UINT8_PREVIEW_BYTES = 32;
const MAX_STRING_PREVIEW_CHARS = 200;

function hexOf(bytes: Uint8Array, max: number): string {
  const preview = bytes.subarray(0, max);
  return `${toHex(preview)}${bytes.length > max ? '…' : ''}`;
}

export function isUint8ArrayLike(v: unknown): v is Uint8Array {
  if (v instanceof Uint8Array) {
    return true;
  }
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  return (v as { constructor?: { name?: string } }).constructor?.name === 'Uint8Array';
}

export function makeReplacer(): (this: unknown, k: string, v: unknown) => unknown {
  const seen = new WeakSet();
  return function replacer(_k, v) {
    if (typeof v === 'bigint') {
      return `${v.toString()}n`;
    }
    if (typeof v === 'string' && v.length > MAX_STRING_PREVIEW_CHARS) {
      return v.slice(0, MAX_STRING_PREVIEW_CHARS) + `…(+${String(v.length - MAX_STRING_PREVIEW_CHARS)})`;
    }
    if (isUint8ArrayLike(v)) {
      return {
        __type: 'Uint8Array',
        length: v.length,
        hex: hexOf(v, MAX_UINT8_PREVIEW_BYTES),
      };
    }
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) {
        return '[Circular]';
      }
      seen.add(v);
    }
    return v;
  };
}

export function formatPayloadDetail(payload: unknown): string {
  try {
    return JSON.stringify(payload, makeReplacer(), 2);
  } catch (err) {
    return `<format error: ${err instanceof Error ? err.message : String(err)}>`;
  }
}

export function formatPayloadSummary(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return '';
  }
  if (isUint8ArrayLike(payload)) {
    return `bytes[${String(payload.length)}] ${hexOf(payload, 8)}`;
  }
  if (typeof payload !== 'object') {
    return truncate(stringifyPrimitive(payload), 80);
  }
  const obj = payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (parts.length >= 3) {
      parts.push('…');
      break;
    }
    parts.push(`${k}=${formatInline(v)}`);
  }
  return truncate(parts.join(' '), 80);
}

function formatInline(v: unknown): string {
  if (v === null) {
    return 'null';
  }
  if (v === undefined) {
    return 'undef';
  }
  if (isUint8ArrayLike(v)) {
    return `bytes[${String(v.length)}]`;
  }
  if (typeof v === 'bigint') {
    return `${v.toString()}n`;
  }
  if (typeof v === 'string') {
    return `"${truncate(v, 24)}"`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      return '{}';
    }
    if (keys.length === 2 && 'tag' in obj && 'value' in obj) {
      return `{${stringifyPrimitive(obj['tag'])}}`;
    }
    return `{${String(keys.length)} keys}`;
  }
  return '?';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Refuses to fall back to `[object Object]`. */
function stringifyPrimitive(v: unknown): string {
  if (v === null) {
    return 'null';
  }
  if (v === undefined) {
    return 'undef';
  }
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  if (typeof v === 'symbol') {
    return v.toString();
  }
  return '?';
}
