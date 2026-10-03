// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS-modules options shared by the host, the sandbox and the ui tests.
 *
 * In dev a class is `Spinner_spinner_ab12`, so a name in devtools points at
 * its file. In production it is the next name of a build-wide counter (`a`,
 * `b`, ..., `z`, `aa`, `ab`, ...): the names ship in both the CSS and the JS, so
 * the shortest names keep both small. One counter serves every Vite
 * environment of a build (Astro's prerender and client builds run in one
 * process), so the server-rendered HTML and the client code agree on a name.
 */

import { createHash } from 'node:crypto';
import { basename, relative, resolve } from 'node:path';
import type { CSSModulesOptions } from 'vite';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const FIRST = 'abcdefghijklmnopqrstuvwxyz';
// Lowercase only: a page in quirks mode matches class names case-insensitively.
const REST = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** The `index`th name, shortest first. */
function shortName(index: number): string {
  let n = index;
  let length = 1;
  let count = FIRST.length;
  while (n >= count) {
    n -= count;
    length += 1;
    count *= REST.length;
  }
  let name = '';
  for (let i = 1; i < length; i++) {
    name = (REST[n % REST.length] ?? '') + name;
    n = Math.floor(n / REST.length);
  }
  return (FIRST[n] ?? '') + name;
}

const names = new Map<string, string>();
let next = 0;

function productionName(key: string): string {
  let name = names.get(key);
  if (name === undefined) {
    // Ad blockers hide elements with classes like `ad` and `ads`.
    do {
      name = shortName(next++);
    } while (name.startsWith('ad'));
    names.set(key, name);
  }
  return name;
}

/** Production naming follows NODE_ENV at transform time. */
export function cssModules(): CSSModulesOptions {
  return {
    localsConvention: 'camelCaseOnly',
    generateScopedName: (local, file) => {
      const path = relative(REPO_ROOT, file.replace(/\?.*$/, ''));
      if (process.env['NODE_ENV'] === 'production') {
        return productionName(`${path}:${local}`);
      }
      const hash = createHash('sha256').update(`${path}:${local}`).digest('base64url');
      return `${basename(path).replace(/\.module\.css$/, '')}_${local}_${hash.slice(0, 4)}`;
    },
  };
}
