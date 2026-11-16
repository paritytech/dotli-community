// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import checkerScript from './head/checker.js?inline-script';

/**
 * `html` with the checker first in its `<head>`, else right after a leading doctype, else before everything. Never
 * throws.
 */
export function injectSandboxChecker(html: string): string {
  const tag = `<script>${checkerScript}</script>`;
  const at = /<head(?:\s[^>]*)?>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);
  const end = at === null ? 0 : at.index + at[0].length;
  return html.slice(0, end) + tag + html.slice(end);
}
