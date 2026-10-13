// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import checkerScript from './head/checker.js?inline-script';

/** Puts the checker first in the product's `<head>`, or before everything when it has none. */
export function injectSandboxChecker(html: string): string {
  const tag = `<script>${checkerScript}</script>`;
  if (html.includes('<head>')) {
    // A replacer function, so no `$` pattern in the script is read as a replacement pattern.
    return html.replace('<head>', () => '<head>' + tag);
  }
  return tag + html;
}
