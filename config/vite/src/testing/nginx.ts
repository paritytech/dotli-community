// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads nginx config back as the headers it sends, so specs can hold the local servers to it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '../../../..');

/**
 * The headers an nginx file sends, following its snippet includes. `file` is relative to the repo root. `default_type`
 * counts as the Content-Type. An `add_header` it cannot read fails the spec, so a value written another way cannot drift
 * unseen. With `location`, only that exact-match location block counts, so two blocks in one file are held apart.
 */
export function nginxHeaders(file: string, location?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let inLocation = location === undefined;
  for (const line of readFileSync(join(REPO, file), 'utf8').split('\n')) {
    if (location !== undefined) {
      if (line.trim() === `location = ${location} {`) {
        inLocation = true;
        continue;
      }
      if (inLocation && line.trim() === '}') {
        break;
      }
    }
    if (!inLocation) {
      continue;
    }
    const include = /^\s*include \/etc\/nginx\/snippets\/(\S+);/.exec(line);
    if (include?.[1] !== undefined) {
      Object.assign(headers, nginxHeaders(`nginx/snippets/${include[1]}`));
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
