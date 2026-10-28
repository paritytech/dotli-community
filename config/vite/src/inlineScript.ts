// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Some scripts are written into documents dotli does not build, such as a product's pages, so they travel as text. They
// stay real modules, and an import with `?inline-script` gives back the module bundled with everything it imports into
// one classic script, as text a response can inline.

import { dirname } from 'node:path';
import { build, type Plugin, type Rolldown } from 'vite';

export type ClassicScript = {
  /** The script's text. */
  code: string;
  /** Every module the script holds, so a change to any of them rebuilds it. */
  modules: string[];
};

const QUERY = 'inline-script';

/**
 * Returns the plugin that resolves `import script from './module.js?inline-script'` to the module's bundled classic
 * script, as a string. Its load fails the build when the module does not bundle to one inline-safe script.
 */
export function inlineScript(): Plugin {
  let target: string | string[] | false = 'es2022';
  return {
    name: 'dotli-inline-script',
    enforce: 'pre',
    configResolved(config) {
      target = config.build.target;
    },
    async load(id) {
      const file = getInlineScriptFile(id);
      if (file === null) {
        return null;
      }
      const script = await bundleClassicScript(file, target);
      for (const module of script.modules) {
        this.addWatchFile(module);
      }
      return `export default ${JSON.stringify(script.code)};\n`;
    },
  };
}

/** Returns the module an `?inline-script` import names, or null for any other id. Never throws. */
export function getInlineScriptFile(id: string): string | null {
  const [file, query] = id.split('?', 2);
  if (file === undefined || query === undefined) {
    return null;
  }
  return new URLSearchParams(query).has(QUERY) ? file : null;
}

/**
 * Returns the one chunk a script bundle must come to. Throws on anything else, which could not run from a single
 * inline tag.
 */
export function toClassicScript(
  file: string,
  output: readonly (Rolldown.OutputChunk | Rolldown.OutputAsset)[],
): ClassicScript {
  const [chunk, ...rest] = output;
  if (chunk?.type !== 'chunk' || rest.length > 0) {
    const names = output.map(item => item.fileName).join(', ');
    throw new Error(`${file} must bundle to one script, got: ${names}`);
  }
  // The HTML parser ends a script at this text wherever it stands, even inside a string.
  if (/<\/script/i.test(chunk.code)) {
    throw new Error(`${file} bundles to a script holding "</script", which would end its inline tag early`);
  }
  return { code: chunk.code, modules: chunk.moduleIds.filter(id => !id.startsWith('\0')) };
}

/**
 * Bundles `file` and what it imports into one self-contained, minified classic script. Rejects when the build fails or
 * does not come to one inline-safe script.
 */
export async function bundleClassicScript(file: string, target: string | string[] | false): Promise<ClassicScript> {
  const result = await build({
    configFile: false,
    envDir: false,
    mode: 'production',
    root: dirname(file),
    publicDir: false,
    logLevel: 'warn',
    build: {
      target,
      write: false,
      copyPublicDir: false,
      emptyOutDir: false,
      modulePreload: false,
      reportCompressedSize: false,
      sourcemap: false,
      minify: 'oxc',
      rolldownOptions: { input: file, output: { format: 'iife', codeSplitting: false } },
    },
  });
  if (!Array.isArray(result) && !('output' in result)) {
    throw new Error(`${file} started a watcher instead of a build`);
  }
  const [only, ...more] = Array.isArray(result) ? result : [result];
  if (only === undefined || more.length > 0) {
    throw new Error(`${file} built ${String(more.length + 1)} outputs, expected one`);
  }
  return toClassicScript(file, only.output);
}
