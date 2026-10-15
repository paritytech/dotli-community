// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product's index.html is written into the window at the URL the visitor opened. Below the root, a relative asset
// would resolve under that path and miss the archive, which holds every file from its root.

/** The page with a `<base>` at the archive root when it is written below the root and sets no base of its own. */
export function withArchiveBase(html: string, pathname: string, root: string): string {
  if (pathname === root || /<base[\s>]/i.test(html)) {
    return html;
  }
  const tag = `<base href="${root}">`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head === null) {
    return tag + html;
  }
  const end = head.index + head[0].length;
  return html.slice(0, end) + tag + html.slice(end);
}
