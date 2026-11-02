// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads nginx config back as the headers it sends.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Params = {
  /** The exact-match location whose block alone counts. */
  location?: string;
};

const REPO = join(import.meta.dirname, '../../../..');

/**
 * Returns the headers an nginx file sends, following its snippet includes. `file` is relative to the repo root.
 * `default_type` counts as the Content-Type. Throws on an `add_header` it cannot read, so a value written another way
 * cannot drift unseen, and when the file cannot be read. With `location`, only that exact-match location block counts,
 * so two blocks in one file are held apart.
 */
export function readNginxHeaders(file: string, { location }: Params = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  let inLocation = location === undefined;
  for (const line of readFileSync(join(REPO, file), 'utf8').split('\n')) {
    if (location !== undefined && line.trim() === `location = ${location} {`) {
      inLocation = true;
      continue;
    }
    if (location !== undefined && inLocation && line.trim() === '}') {
      break;
    }
    if (!inLocation) {
      continue;
    }
    const include = /^\s*include \/etc\/nginx\/snippets\/(\S+);/.exec(line);
    if (include?.[1] !== undefined) {
      Object.assign(headers, readNginxHeaders(`nginx/snippets/${include[1]}`));
    }
    const type = /^\s*default_type (\S+);/.exec(line);
    if (type?.[1] !== undefined) {
      headers['Content-Type'] = type[1];
    }
    if (!/^\s*add_header\b/.test(line)) {
      continue;
    }
    const header = /^\s*add_header (\S+) "([^"]*)"( always)?;\s*$/.exec(line);
    if (header?.[1] === undefined || header[2] === undefined) {
      throw new Error(`${file}: cannot read "${line.trim()}"`);
    }
    headers[header[1]] = header[2];
  }
  return headers;
}
