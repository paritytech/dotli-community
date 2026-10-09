// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export interface EnumValue {
  tag: string;
  value: unknown;
}

const VERSION_TAG = /^[vV]\d+$/;

/** Unwrap one `{tag: "V1", value}` version envelope, leaving other payloads untouched. */
export function peelVersion(v: unknown): unknown {
  const o = asObj(v);
  if (o === undefined) {
    return v;
  }
  if (typeof o['tag'] === 'string' && VERSION_TAG.test(o['tag']) && 'value' in o) {
    return o['value'];
  }
  return v;
}

export function asObj(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === 'object' && v !== null) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

export function asEnum(v: unknown): EnumValue | undefined {
  const o = asObj(v);
  if (o === undefined) {
    return undefined;
  }
  if (typeof o['tag'] !== 'string') {
    return undefined;
  }
  return { tag: o['tag'], value: o['value'] };
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
