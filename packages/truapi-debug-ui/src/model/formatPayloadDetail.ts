// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getErrorMessage } from '@dotli/shared';

import { formatBigInt } from './formatBigInt.js';
import { formatHexPreview } from './formatHexPreview.js';
import { isUint8ArrayLike } from './isUint8ArrayLike.js';

const MAX_UINT8_PREVIEW_BYTES = 32;
const MAX_STRING_PREVIEW_CHARACTERS = 200;

/** A payload as indented JSON for the detail pane, long values cut short. A failure becomes the text, never thrown. */
export function formatPayloadDetail(payload: unknown): string {
  try {
    return JSON.stringify(payload, createReplacer(), 2);
  } catch (error) {
    return `<format error: ${getErrorMessage(error)}>`;
  }
}

function createReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const seen = new WeakSet();
  return function replaceValue(_key, value) {
    if (typeof value === 'bigint') {
      return formatBigInt(value);
    }
    if (typeof value === 'string' && value.length > MAX_STRING_PREVIEW_CHARACTERS) {
      return (
        value.slice(0, MAX_STRING_PREVIEW_CHARACTERS) + `…(+${String(value.length - MAX_STRING_PREVIEW_CHARACTERS)})`
      );
    }
    if (isUint8ArrayLike(value)) {
      return {
        __type: 'Uint8Array',
        length: value.length,
        hex: formatHexPreview(value, MAX_UINT8_PREVIEW_BYTES),
      };
    }
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    return value;
  };
}
