// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSModuleLoaderAsync, JSModuleNormalizerAsync } from 'quickjs-emscripten-core';

/** A module's files, by path. */
export type ModuleFiles = ReadonlyMap<string, Uint8Array>;

/**
 * The loader and normalizer that resolve a VM's imports from `files`. A relative specifier resolves against the
 * directory of the module that imports it. Any other specifier is a path in `files` as written.
 */
export function createModuleLoader(files: ModuleFiles) {
  const decoder = new TextDecoder();

  // Both answer at once rather than through a promise: an asyncify VM suspends on a promise, and a call into a
  // suspended VM, such as a message the host delivers meanwhile, corrupts it.
  const normalize: JSModuleNormalizerAsync = (importer, specifier) => resolveSpecifier(specifier, importer);
  const load: JSModuleLoaderAsync = path => {
    const bytes = files.get(path);
    if (!bytes) {
      return { error: new Error(`Module '${path}' is not in the files`) };
    }
    return decoder.decode(bytes);
  };

  return { normalize, load };
}

function resolveSpecifier(specifier: string, importer: string): string {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return specifier;
  }
  const segments = importer.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '..') {
      segments.pop();
    } else if (part !== '' && part !== '.') {
      segments.push(part);
    }
  }
  return segments.join('/');
}
