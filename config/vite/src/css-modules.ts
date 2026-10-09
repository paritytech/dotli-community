// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS-modules options shared by the host, the sandbox and the ui tests.
 * One counter serves every Vite environment of a build, so prerendered HTML and client code agree on a name.
 */

import { createHash } from 'node:crypto';
import { basename, relative, resolve } from 'node:path';
import type { CSSModulesOptions } from 'vite';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

// A class name cannot start with a digit, so the first character is a letter.
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** The `index`th name, shortest first and never repeated: a letter, then the rest in bijective base 36. */
function shortName(index: number) {
  let name = LETTERS.charAt(index % LETTERS.length);
  let rest = Math.floor(index / LETTERS.length);
  while (rest > 0) {
    rest -= 1;
    name += CHARS.charAt(rest % CHARS.length);
    rest = Math.floor(rest / CHARS.length);
  }
  return name;
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
