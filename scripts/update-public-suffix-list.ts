// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Refreshes the vendored Public Suffix List the session window reads. Run with each release.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://publicsuffix.org/list/public_suffix_list.dat';
const OUTPUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps/host/src/runtime/site-sign-in/public-suffix-list.dat',
);
const SECTIONS = ['===BEGIN ICANN DOMAINS===', '===BEGIN PRIVATE DOMAINS===', '===END PRIVATE DOMAINS==='];

/** Throws unless `body` holds both sections whole, so an error page or a cut download never replaces the list. */
export function checkSections(body: string): void {
  for (const marker of SECTIONS) {
    if (!body.includes(marker)) {
      throw new Error(`the downloaded list has no ${marker} marker`);
    }
  }
}

if (import.meta.main) {
  const response = await fetch(SOURCE);
  if (!response.ok) {
    throw new Error(`${SOURCE} answered ${String(response.status)}`);
  }
  const body = await response.text();
  checkSections(body);
  writeFileSync(OUTPUT, body);
  console.log(`Wrote ${OUTPUT}`);
}
