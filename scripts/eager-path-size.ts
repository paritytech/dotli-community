// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Size of what a first visit downloads before any lazy import: the module
// entry plus every chunk `dist/index.html` modulepreloads, and the Astro
// islands that hydrate at load (`client="load"`) with their renderer and
// every chunk those import statically. Watching only the entry misses growth
// the bundler moves into a preloaded chunk or an island.
//
//   node scripts/eager-path-size.ts apps/host/dist
//   → {"files":["assets/index-….js",…],"raw":…,"gz":…,"br":…}

import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { brotliCompressSync } from 'node:zlib';

// gzip goes through the `gzip` CLI, not zlib.gzipSync: the CI budgets and
// docs/perf/solid-migration-baseline.md were both measured with the CLI,
// and Node's zlib bindings produce output that was up to ~2% larger
// in total on the measured builds, which would make this script's numbers
// incomparable to them. The file path (not piped stdin bytes) is passed to
// `gzip -c`, matching the baseline's method exactly: `gzip -c <file>` stores
// the original filename in the gzip header, which stdin piping omits, so
// piping bytes undercounts by ~20 B per file (confirmed against the
// baseline). The CLI match is exact with the macOS (Apple) gzip that
// produced the baseline tables; GNU gzip on the CI runner may differ by a
// few bytes to a few hundred in total, which is small against the budgets'
// headroom.
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
    throw new Error('index.html has no <script type="module" src>');
  }
  return paths;
}

const ISLAND = /<astro-island\b([^>]*)>/gi;

/** The modules of the islands that hydrate at load: each one's component and renderer. */
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

// A static `import … from "x"`, `import "x"` or `export … from "x"` in the
// bundler's output, not a dynamic `import("x")`.
const STATIC_IMPORT = /(?:^|[;}\s])(?:import|export)\s*(?:[^"'`();]*?\bfrom\s*)?["']([^"']+)["']/g;

/** The relative modules `code` imports statically. */
export function staticImports(code: string): string[] {
  return [...code.matchAll(STATIC_IMPORT)].map(m => m[1] ?? '').filter(spec => spec.startsWith('.'));
}

export function measureEagerPath(distDir: string): {
  files: string[];
  raw: number;
  gz: number;
  br: number;
} {
  const html = readFileSync(join(distDir, 'index.html'), 'utf8');
  const files = [...eagerChunkPaths(html), ...loadIslandModules(html)].map(p => p.replace(/^\.?\//, ''));
  // The islands' static imports, and theirs (the loop reaches the ones it
  // appends); the entry's are modulepreloaded.
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
  const distDir = process.argv[2];
  if (distDir === undefined) {
    console.error('usage: node scripts/eager-path-size.ts <distDir>');
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(measureEagerPath(distDir)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
