// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// An app grouped into feature folders: other code reaches a feature only through its index, and the shared kit and the
// features never reach up into the shell or the pages.

import path from 'node:path';
import { defineConfig } from 'eslint/config';

/**
 * An import, a re-export or an `import()`, as far as the boundary reads it.
 * @typedef {{
 *   importKind?: string,
 *   exportKind?: string,
 *   specifiers?: Array<{ importKind?: string, exportKind?: string }>,
 *   source?: { type: string, value?: unknown } | null,
 * }} ModuleReference
 */
/** @typedef {'index' | 'upward'} Violation */

/**
 * The unit a file belongs to under its app's `src/`, such as `features/chat`, `shell` or `kit`, or null outside it.
 * @param {string} file
 * @returns {string | null}
 */
function unitOf(file) {
  const parts = file.split(path.sep);
  const at = parts.lastIndexOf('src');
  const top = parts[at + 1];
  if (at < 0 || top === undefined) {
    return null;
  }
  return top === 'features' ? `features/${parts[at + 2] ?? ''}` : top;
}

/** @param {string} file */
function isTestCode(file) {
  return /\.(spec|stories|fake)\.tsx?$/.test(file) || file.split(path.sep).includes('__tests__');
}

/** @param {ModuleReference} node */
function isTypeOnly(node) {
  if ((node.importKind ?? node.exportKind) === 'type') {
    return true;
  }
  const specifiers = node.specifiers ?? [];
  return specifiers.length > 0 && specifiers.every(s => (s.importKind ?? s.exportKind) === 'type');
}

/** @param {ModuleReference} node */
function specifierOf(node) {
  const source = node.source;
  return source?.type === 'Literal' && typeof source.value === 'string' ? source.value : null;
}

/**
 * What a reference from unit `from` to `target`, in unit `to`, breaks, or null when it is allowed. Astro markup imports
 * an island or a component by its own module, since Astro hydrates the module the markup imports.
 * @param {{ from: string, to: string, target: string, typeOnly: boolean, fromMarkup: boolean }} params
 * @returns {Violation | null}
 */
function findViolation({ from, to, target, typeOnly, fromMarkup }) {
  const below = from === 'kit' || from.startsWith('features/');
  if (below && (to === 'shell' || to === 'pages')) {
    return 'upward';
  }
  if (!to.startsWith('features/') || typeOnly || fromMarkup) {
    return null;
  }
  if (from === 'kit') {
    return 'upward';
  }
  const isIndex = /^index(\.[jt]sx?)?$/.test(path.basename(target)) && path.dirname(target).endsWith(to);
  return isIndex ? null : 'index';
}

/** @type {import('eslint').Rule.RuleModule} */
const featureBoundary = {
  meta: {
    type: 'problem',
    messages: {
      index: 'Import the {{to}} feature through its index.ts, never its internal modules.',
      upward: '{{from}} never imports {{to}}, which sits above it.',
    },
    schema: [],
  },
  create(context) {
    const file = context.filename;
    const unit = unitOf(file);
    if (unit === null || unit === 'testing' || isTestCode(file)) {
      return {};
    }
    const from = unit;
    const fromMarkup = file.endsWith('.astro');
    /** @param {ModuleReference} node */
    function check(node) {
      const spec = specifierOf(node);
      if (spec?.startsWith('.') !== true) {
        return;
      }
      const target = path.resolve(path.dirname(file), spec.split('?')[0] ?? spec);
      const to = unitOf(target);
      if (to === null || to === from) {
        return;
      }
      const messageId = findViolation({ from, to, target, typeOnly: isTypeOnly(node), fromMarkup });
      if (messageId !== null && node.source) {
        context.report({
          node: /** @type {import('eslint').Rule.Node} */ (node.source),
          messageId,
          data: { from, to },
        });
      }
    }
    return /** @type {import('eslint').Rule.RuleListener} */ ({
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    });
  },
};

/**
 * Turns on the feature boundary for an app's `src/`. A type-only import may reach a feature's internals, and so may
 * Astro markup. Tests and shared fixtures are exempt.
 */
export function featureBoundaries() {
  return defineConfig([
    {
      files: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.astro'],
      plugins: { app: { rules: { 'feature-boundary': featureBoundary } } },
      rules: { 'app/feature-boundary': 'error' },
    },
  ]);
}
