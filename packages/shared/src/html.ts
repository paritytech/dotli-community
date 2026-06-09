// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Escape a string for safe interpolation into innerHTML.
 *
 * Covers all five HTML-significant characters: & < > " '
 *
 * The single quote is necessary because interpolations like
 * `<a onclick='...${value}...'>` land inside a single-quoted attribute.
 * Without escaping it, a contributor using this helper for a
 * single-quoted attribute would have no indication the output was unsafe.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * `.dot` label validator.
 *
 * Contract (closed set, no silent acceptance):
 *   - Lowercase ASCII `a-z 0-9` and interior `-` only.
 *   - Length 1..63 (DNS label cap).
 *   - No leading or trailing hyphen.
 *   - No IDN, Unicode, or uppercase input. Callers that take user input
 *     must NFC-normalize and lowercase BEFORE validating. This function
 *     deliberately does not normalize its input, because a helper that
 *     silently case-folds would hide inputs that disagree with the
 *     canonical network registration form.
 */
const DOT_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type DotLabelResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "empty"
        | "too-long"
        | "uppercase"
        | "leading-hyphen"
        | "trailing-hyphen"
        | "invalid-char"
        | "non-ascii";
    };

/**
 * Return a specific failure reason instead of a bare boolean so log
 * lines and UI validation messages can say why a label was rejected.
 */
export function validateDotLabel(label: string): DotLabelResult {
  if (label.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (label.length > 63) {
    return { ok: false, reason: "too-long" };
  }
  if (label !== label.toLowerCase()) {
    return { ok: false, reason: "uppercase" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(label)) {
    return { ok: false, reason: "non-ascii" };
  }
  if (label.startsWith("-")) {
    return { ok: false, reason: "leading-hyphen" };
  }
  if (label.endsWith("-")) {
    return { ok: false, reason: "trailing-hyphen" };
  }
  if (!DOT_LABEL_RE.test(label)) {
    return { ok: false, reason: "invalid-char" };
  }
  return { ok: true };
}

/** Backwards-compatible boolean wrapper over `validateDotLabel`. */
export function isValidDotLabel(label: string): boolean {
  return validateDotLabel(label).ok;
}
