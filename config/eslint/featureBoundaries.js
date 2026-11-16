// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// An app grouped into feature folders: other code reaches a feature only through its index, and the shared kit and the
// features never reach up into the shell or the pages.

import path from 'node:path';
import { defineConfig } from 'eslint/config';
import { featureTestFiles, storyFiles, testOnlyFiles } from './testFiles.js';

/**
 * An import, a re-export or an `import()`, as far as the boundary reads it.
 * @typedef {{
 *   importKind?: string,
 *   exportKind?: string,
 *   specifiers?: Array<{ importKind?: string, exportKind?: string }>,
 *   source?: { type: string, value?: unknown } | null,
 * }} ModuleReference
 */

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

/** @param {ModuleReference} node */
function isTypeOnly(node) {
  if ((node.importKind ?? node.exportKind) === 'type') {
    return true;
  }
  const specifiers = node.specifiers ?? [];
  return specifiers.length > 0 && specifiers.every(s => (s.importKind ?? s.exportKind) === 'type');
}

/**
 * The source literal of a reference to a relative module, as ESLint reports on it, or null for a package or a computed
 * `import()`.
 * @param {ModuleReference} node
 * @returns {(import('eslint').Rule.Node & { value: string }) | null}
 */
function relativeSourceOf(node) {
  const source = node.source;
  if (source?.type !== 'Literal' || typeof source.value !== 'string' || !source.value.startsWith('.')) {
    return null;
  }
  return /** @type {import('eslint').Rule.Node & { value: string }} */ (source);
}

/**
 * Whether unit `from` reaches above itself into unit `to`. Kit and the features never import the shell or the pages,
 * and kit imports no feature at runtime.
 * @param {{ from: string, to: string, typeOnly: boolean }} params
 */
function reachesUp({ from, to, typeOnly }) {
  const isKit = from === 'kit';
  if ((isKit || from.startsWith('features/')) && (to === 'shell' || to === 'pages')) {
    return true;
  }
  return isKit && to.startsWith('features/') && !typeOnly;
}

/**
 * Whether a reference into feature unit `to` skips its index. A type-only import may reach past the index. So may Astro
 * markup that imports an Astro component or an island, since Astro hydrates the module the markup imports.
 * @param {{ to: string, target: string, typeOnly: boolean, fromMarkup: boolean }} params
 */
function skipsIndex({ to, target, typeOnly, fromMarkup }) {
  const markupPart = fromMarkup && (target.endsWith('.astro') || /Island\.[jt]sx?$/.test(target));
  if (!to.startsWith('features/') || typeOnly || markupPart) {
    return false;
  }
  const isIndex = /^index(\.[jt]sx?)?$/.test(path.basename(target)) && path.dirname(target).endsWith(to);
  return !isIndex;
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
    if (unit === null) {
      return {};
    }
    // The check below is a declaration, which TypeScript does not narrow `unit` inside.
    const from = unit;
    const fromMarkup = file.endsWith('.astro');
    /** @param {ModuleReference} node */
    function check(node) {
      const source = relativeSourceOf(node);
      if (source === null) {
        return;
      }
      // A query such as `?url` or `?worker` names a build variant of the same module.
      const [bare = source.value] = source.value.split('?');
      const target = path.resolve(path.dirname(file), bare);
      const to = unitOf(target);
      if (to === null || to === from) {
        return;
      }
      const typeOnly = isTypeOnly(node);
      if (reachesUp({ from, to, typeOnly })) {
        context.report({ node: source, messageId: 'upward', data: { from, to } });
      } else if (skipsIndex({ to, target, typeOnly, fromMarkup })) {
        context.report({ node: source, messageId: 'index', data: { from, to } });
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
 * Turns on the feature boundary for an app's `src/`. Tests and shared fixtures reach into features on purpose and are
 * left out.
 */
export function featureBoundaries() {
  return defineConfig([
    {
      files: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.astro'],
      ignores: [...testOnlyFiles, ...featureTestFiles, ...storyFiles],
      plugins: { app: { rules: { 'feature-boundary': featureBoundary } } },
      rules: { 'app/feature-boundary': 'error' },
    },
  ]);
}
