// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * A dotNS label. Callers lowercase user input first, because folding here would hide input
 * that disagrees with the registered form.
 */
const DOT_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Marks a subname's sandbox label, so no registered label can take a subname's origin. */
const SUBNAME_SANDBOX_PREFIX = 'sn--';

/** The longest label a DNS name can carry. */
const MAX_LABEL_LENGTH = 63;

/** The longest name a DNS hostname can carry. */
const MAX_NAME_LENGTH = 253;

export type DotLabelResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'empty'
        | 'too-long'
        | 'uppercase'
        | 'leading-hyphen'
        | 'trailing-hyphen'
        | 'invalid-char'
        | 'non-ascii'
        | 'punycode'
        | 'reserved';
    };

export function validateDotLabel(label: string): DotLabelResult {
  if (label.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (label.length > MAX_LABEL_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }
  if (label !== label.toLowerCase()) {
    return { ok: false, reason: 'uppercase' };
  }
  // eslint-disable-next-line no-control-regex -- the range covers all of ASCII, NUL included.
  if (/[^\x00-\x7f]/.test(label)) {
    return { ok: false, reason: 'non-ascii' };
  }
  // A punycode label can spell a name in letters that only look like another name's.
  if (label.startsWith('xn--')) {
    return { ok: false, reason: 'punycode' };
  }
  if (label.startsWith(SUBNAME_SANDBOX_PREFIX)) {
    return { ok: false, reason: 'reserved' };
  }
  if (label.startsWith('-')) {
    return { ok: false, reason: 'leading-hyphen' };
  }
  if (label.endsWith('-')) {
    return { ok: false, reason: 'trailing-hyphen' };
  }
  if (!DOT_LABEL_RE.test(label)) {
    return { ok: false, reason: 'invalid-char' };
  }
  return { ok: true };
}

export function isValidDotLabel(label: string): boolean {
  return validateDotLabel(label).ok;
}

/** A dotNS name: one label, or a subname whose labels are each valid, such as `pr16.my-app`. */
export function validateDotName(name: string): DotLabelResult {
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }
  for (const label of name.split('.')) {
    const result = validateDotLabel(label);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}

export function isValidDotName(name: string): boolean {
  return validateDotName(name).ok;
}

/**
 * The one DNS label a product's sandbox origin is named by. A wildcard certificate covers a single label, so a subname
 * gets a hash of its name. A label keeps itself, so the origins, and the storage, of products opened before stay.
 *
 * > CAUTION!
 * > This function should be super stable and does not change behavior for each case, you can only extend it.
 * > Site origin and all storages are bound to the domain name, so every change will effectively drop all user data.
 */
export function sandboxLabel(name: string): string {
  if (!name.includes('.')) {
    return name;
  }
  const digest = bytesToHex(sha256(new TextEncoder().encode(name)));
  return `${SUBNAME_SANDBOX_PREFIX}${digest.slice(0, MAX_LABEL_LENGTH - SUBNAME_SANDBOX_PREFIX.length)}`;
}
