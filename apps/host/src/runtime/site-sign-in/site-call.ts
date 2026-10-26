// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A site's decoded call as text the review shows. */

import { toHex } from '@dotli/shared';

/** A call's name and its top-level arguments, each rendered as text. */
export type DisplayCall = {
  /** `<Pallet>.<call>`. */
  name: string;
  args: { name: string; value: string }[];
};

/** What a value becomes inside JSON, so bigints, bytes and absent values keep their text form there too. */
function jsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return toHex(value);
  }
  if (value === undefined) {
    return 'none';
  }
  if (Array.isArray(value)) {
    return value.map(jsonValue);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, jsonValue(inner)]));
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'bigint' || typeof value === 'number') {
    return value.toString();
  }
  if (value === undefined) {
    return 'none';
  }
  return value instanceof Uint8Array ? toHex(value) : JSON.stringify(jsonValue(value), null, 2);
}

/** Renders papi's decoded call for the review: its name and each top-level argument as text. */
export function displayCall(decoded: { type: string; value: { type: string; value: unknown } }): DisplayCall {
  const args = decoded.value.value;
  return {
    name: `${decoded.type}.${decoded.value.type}`,
    args:
      typeof args === 'object' && args !== null
        ? Object.entries(args).map(([name, value]) => ({ name, value: text(value) }))
        : [],
  };
}
