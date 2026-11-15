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
 * so two blocks in one file are held apart. It throws too when that block is missing, has no end or nests a block, so
 * a misspelt location cannot read as one that sends nothing.
 */
export function readNginxHeaders(file: string, { location }: Params = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of selectLocation(readFileSync(join(REPO, file), 'utf8').split('\n'), location)) {
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

/**
 * Returns the lines that count: every line, or with `location` only those inside its exact-match block. Throws when
 * the file holds no such block, when the block has no end, or when it nests a block, which its first `}` would cut
 * short.
 */
function selectLocation(lines: string[], location: string | undefined): string[] {
  if (location === undefined) {
    return lines;
  }
  const start = lines.findIndex(line => line.trim() === `location = ${location} {`);
  const end = lines.findIndex((line, index) => index > start && line.trim() === '}');
  if (start === -1 || end === -1) {
    throw new Error(`No whole block for location = ${location}`);
  }
  const block = lines.slice(start + 1, end);
  const nested = block.find(line => line.trimEnd().endsWith('{'));
  if (nested !== undefined) {
    throw new Error(`location = ${location}: cannot read the nested block "${nested.trim()}"`);
  }
  return block;
}
