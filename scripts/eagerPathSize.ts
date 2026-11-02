// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a first visit downloads before any lazy import: the entry, its modulepreloads, and the islands that hydrate at
// load with everything they import statically. Watching only the entry misses growth moved into those.

import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { brotliCompressSync } from 'node:zlib';

type Params = {
  /** The page to measure, relative to the build folder. Defaults to `index.html`. */
  page?: string | undefined;
};

const TAG = /<(script|link)\b([^>]*)>/gi;

const ISLAND = /<astro-island\b([^>]*)>/gi;

// A static import or re-export in bundler output, not a dynamic `import("x")`.
const STATIC_IMPORT = /(?:^|[;}\s])(?:import|export)\s*(?:[^"'`();]*?\bfrom\s*)?["']([^"']+)["']/g;

/**
 * The files a first visit to `page` downloads, with their summed raw, gzip and brotli sizes. Throws when a file cannot
 * be read, the page has no module entry, or the `gzip` CLI fails.
 */
export function measureEagerPath(
  distDir: string,
  { page = 'index.html' }: Params = {},
): {
  files: string[];
  raw: number;
  gz: number;
  br: number;
} {
  const html = readFileSync(join(distDir, page), 'utf8');
  const files = [...listEagerChunkPaths(html), ...listLoadIslandModules(html)].map(path => path.replace(/^\.?\//, ''));
  // Transitive, since the loop reaches what it appends. The entry's imports are already modulepreloaded.
  for (const file of files) {
    for (const specifier of listStaticImports(readFileSync(join(distDir, file), 'utf8'))) {
      const dependency = posix.normalize(posix.join(dirname(file), specifier));
      if (files.includes(dependency)) {
        continue;
      }
      files.push(dependency);
    }
  }
  let raw = 0;
  let gz = 0;
  let br = 0;
  for (const file of files) {
    const filePath = join(distDir, file);
    const bytes = readFileSync(filePath);
    raw += bytes.length;
    gz += measureGzipCliSize(filePath);
    br += brotliCompressSync(bytes).length;
  }
  return { files, raw, gz, br };
}

/** The module entry and every modulepreload, in document order and once each. Throws when the page has no entry. */
export function listEagerChunkPaths(html: string): string[] {
  const paths: string[] = [];
  let hasEntry = false;
  for (const [, tag = '', attributes = ''] of html.matchAll(TAG)) {
    let path: string | null = null;
    if (tag.toLowerCase() === 'script' && readAttribute(attributes, 'type') === 'module') {
      path = readAttribute(attributes, 'src');
      hasEntry ||= path !== null;
    } else if (tag.toLowerCase() === 'link' && readAttribute(attributes, 'rel') === 'modulepreload') {
      path = readAttribute(attributes, 'href');
    }
    if (path !== null && !paths.includes(path)) {
      paths.push(path);
    }
  }
  if (!hasEntry) {
    throw new Error('the page has no <script type="module" src>');
  }
  return paths;
}

/** The component and renderer of each island that hydrates at load, once each. Never throws. */
export function listLoadIslandModules(html: string): string[] {
  const paths: string[] = [];
  for (const [, attributes = ''] of html.matchAll(ISLAND)) {
    if (readAttribute(attributes, 'client') !== 'load') {
      continue;
    }
    for (const name of ['component-url', 'renderer-url']) {
      const path = readAttribute(attributes, name);
      if (path === null || paths.includes(path)) {
        continue;
      }
      paths.push(path);
    }
  }
  return paths;
}

/** The relative modules `code` imports or re-exports statically. Never throws. */
export function listStaticImports(code: string): string[] {
  return [...code.matchAll(STATIC_IMPORT)].map(match => match[1] ?? '').filter(specifier => specifier.startsWith('.'));
}

function readAttribute(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attributes);
  return match?.[1] ?? null;
}

// The `gzip` CLI on a file path, since zlib runs up to 2% larger and piped stdin drops the filename from the header.
function measureGzipCliSize(filePath: string): number {
  const result = spawnSync('gzip', ['-c', filePath]);
  if (result.error) {
    throw new Error(`${filePath}: gzip CLI failed: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`${filePath}: gzip CLI exited with status ${String(result.status)}`);
  }
  return result.stdout.length;
}

if (import.meta.main) {
  const [distDir, page] = process.argv.slice(2);
  if (distDir === undefined) {
    console.error('usage: node scripts/eagerPathSize.ts <distDir> [page.html]');
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(measureEagerPath(distDir, { page })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
