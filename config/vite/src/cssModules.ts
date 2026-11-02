// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS-modules options. One counter serves every Vite environment of a build, so prerendered HTML and client code agree on a name.
 */

import { createHash } from 'node:crypto';
import { basename, relative, resolve } from 'node:path';
import type { CSSModulesOptions } from 'vite';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

// A class name cannot start with a digit, so the first character is a letter.
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

const names = new Map<string, string>();
let next = 0;

/** Returns the CSS-modules options. Production naming follows NODE_ENV at transform time. Never throws. */
export function cssModules(): CSSModulesOptions {
  return {
    localsConvention: 'camelCaseOnly',
    generateScopedName(local, file) {
      const path = relative(REPO_ROOT, file.replace(/\?.*$/, ''));
      if (process.env['NODE_ENV'] === 'production') {
        return getProductionName(`${path}:${local}`);
      }
      const hash = createHash('sha256').update(`${path}:${local}`).digest('base64url');
      return `${basename(path).replace(/\.module\.css$/, '')}_${local}_${hash.slice(0, 4)}`;
    },
  };
}

function getProductionName(key: string): string {
  let name = names.get(key);
  if (name === undefined) {
    // Ad blockers hide elements with classes like `ad` and `ads`.
    do {
      name = createShortName(next++);
    } while (name.startsWith('ad'));
    names.set(key, name);
  }
  return name;
}

/** The `index`th name, shortest first and never repeated: a letter, then the rest in bijective base 36. */
function createShortName(index: number) {
  let name = LETTERS.charAt(index % LETTERS.length);
  let rest = Math.floor(index / LETTERS.length);
  while (rest > 0) {
    rest -= 1;
    name += CHARACTERS.charAt(rest % CHARACTERS.length);
    rest = Math.floor(rest / CHARACTERS.length);
  }
  return name;
}
