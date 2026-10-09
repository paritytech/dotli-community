// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a first visit downloads before any lazy import: the entry, its modulepreloads, and the islands that hydrate at
// load with everything they import statically. Watching only the entry misses growth moved into those.

import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { brotliCompressSync } from 'node:zlib';

// The `gzip` CLI on a file path, as the CI budgets and baseline were measured. zlib runs up to 2% larger, and piped
// stdin drops the filename from the header.
function gzipCliSize(filePath: string): number {
  const result = spawnSync('gzip', ['-c', filePath]);
  if (result.error) {
    throw new Error(`gzip CLI failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`gzip CLI exited with status ${String(result.status)}`);
  }
  return result.stdout.length;
}

const TAG = /<(script|link)\b([^>]*)>/gi;

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs);
  return match?.[1] ?? null;
}

export function eagerChunkPaths(html: string): string[] {
  const paths: string[] = [];
  let hasEntry = false;
  for (const [, tag = '', attrs = ''] of html.matchAll(TAG)) {
    let path: string | null = null;
    if (tag.toLowerCase() === 'script' && attr(attrs, 'type') === 'module') {
      path = attr(attrs, 'src');
      hasEntry ||= path !== null;
    } else if (tag.toLowerCase() === 'link' && attr(attrs, 'rel') === 'modulepreload') {
      path = attr(attrs, 'href');
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

const ISLAND = /<astro-island\b([^>]*)>/gi;

export function loadIslandModules(html: string): string[] {
  const paths: string[] = [];
  for (const [, attrs = ''] of html.matchAll(ISLAND)) {
    if (attr(attrs, 'client') !== 'load') {
      continue;
    }
    for (const name of ['component-url', 'renderer-url']) {
      const path = attr(attrs, name);
      if (path !== null && !paths.includes(path)) {
        paths.push(path);
      }
    }
  }
  return paths;
}

// A static import or re-export in bundler output, not a dynamic `import("x")`.
const STATIC_IMPORT = /(?:^|[;}\s])(?:import|export)\s*(?:[^"'`();]*?\bfrom\s*)?["']([^"']+)["']/g;

export function staticImports(code: string): string[] {
  return [...code.matchAll(STATIC_IMPORT)].map(m => m[1] ?? '').filter(spec => spec.startsWith('.'));
}

export function measureEagerPath(
  distDir: string,
  page = 'index.html',
): {
  files: string[];
  raw: number;
  gz: number;
  br: number;
} {
  const html = readFileSync(join(distDir, page), 'utf8');
  const files = [...eagerChunkPaths(html), ...loadIslandModules(html)].map(p => p.replace(/^\.?\//, ''));
  // Transitive, since the loop reaches what it appends. The entry's imports are already modulepreloaded.
  for (const file of files) {
    for (const spec of staticImports(readFileSync(join(distDir, file), 'utf8'))) {
      const dependency = posix.normalize(posix.join(dirname(file), spec));
      if (!files.includes(dependency)) {
        files.push(dependency);
      }
    }
  }
  let raw = 0;
  let gz = 0;
  let br = 0;
  for (const file of files) {
    const filePath = join(distDir, file);
    const bytes = readFileSync(filePath);
    raw += bytes.length;
    gz += gzipCliSize(filePath);
    br += brotliCompressSync(bytes).length;
  }
  return { files, raw, gz, br };
}

if (import.meta.main) {
  const [distDir, page] = process.argv.slice(2);
  if (distDir === undefined) {
    console.error('usage: node scripts/eager-path-size.ts <distDir> [page.html]');
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(measureEagerPath(distDir, page)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
