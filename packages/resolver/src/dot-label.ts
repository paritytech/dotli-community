// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A dotNS label. Callers normalize and lowercase user input first, because folding here would hide input
 * that disagrees with the registered form.
 */
const DOT_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type DotLabelResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'empty' | 'too-long' | 'uppercase' | 'leading-hyphen' | 'trailing-hyphen' | 'invalid-char' | 'non-ascii';
    };

export function validateDotLabel(label: string): DotLabelResult {
  if (label.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (label.length > 63) {
    return { ok: false, reason: 'too-long' };
  }
  if (label !== label.toLowerCase()) {
    return { ok: false, reason: 'uppercase' };
  }
  // eslint-disable-next-line no-control-regex -- the range covers all of ASCII, NUL included.
  if (/[^\x00-\x7f]/.test(label)) {
    return { ok: false, reason: 'non-ascii' };
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
