// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Sizes of the apps' builds: every emitted file by hash-stripped name, plus the eager path of each app's pages.
// `compare` prints tab-separated `kind name count raw br gz base_raw base_br base_gz`. The base fields come last so a
// shell `read` keeps the others in place when they are empty.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { measureEagerPath } from './eagerPathSize.ts';

export type Size = {
  raw: number;
  br: number;
  gz: number;
};

export type NamedSize = {
  /** How many files share the name once their hashes are stripped. */
  count: number;
} & Size;

export type Baseline = Record<string, Size>;

export type Comparison = {
  files: { name: string; size: NamedSize; base: Size | null }[];
  total: Size;
  /** Main's whole build, files this build no longer has included, so an added, removed or renamed file shows. */
  baseTotal: Size | null;
};

type Params = {
  /** The first column: `file`, `eager` or `total`. */
  kind: string;
  name: string;
  /** How many files share the name, or `-` for a row that is no single file. */
  count: number | '-';
  size: Size;
  /** The baseline's size, or null to leave the base columns empty. */
  base: Size | null;
};

const EAGER_SUFFIX = '/(eager path)';

/** `assets/fetch-CMRV9u5T.js` becomes `assets/fetch.js`. */
export function stripHash(path: string): string {
  return path.replace(/[.-][A-Za-z0-9_-]{8}\./, '.');
}

/** Sums sizes by name, since several files can share one once their hashes are stripped. */
export function sumByName(files: readonly (Size & { name: string })[]): Map<string, NamedSize> {
  const sums = new Map<string, NamedSize>();
  for (const { name, raw, br, gz } of files) {
    const sum = sums.get(name) ?? { count: 0, raw: 0, br: 0, gz: 0 };
    sums.set(name, { count: sum.count + 1, raw: sum.raw + raw, br: sum.br + br, gz: sum.gz + gz });
  }
  return sums;
}

/**
 * Every file an app's build emits, sized raw and by its precompressed siblings (the raw size when there is none).
 * Throws when `distDir` cannot be read.
 */
export function measureApp(app: string, distDir: string): (Size & { name: string })[] {
  const files: (Size & { name: string })[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (!/\.(br|gz|map)$/.test(entry.name)) {
        const raw = statSync(path).size;
        const sibling = (extension: string): number =>
          existsSync(`${path}.${extension}`) ? statSync(`${path}.${extension}`).size : raw;
        files.push({ name: stripHash(`${app}/${relative(distDir, path)}`), raw, br: sibling('br'), gz: sibling('gz') });
      }
    }
  }
  walk(distDir);
  return files;
}

/** Pairs each current file with its baseline entry and totals both sides. Never throws. */
export function compare(current: Map<string, NamedSize>, baseline: Baseline | null): Comparison {
  const files = [...current].map(([name, size]) => ({ name, size, base: baseline?.[name] ?? null }));
  const baseFiles =
    baseline === null ? null : Object.entries(baseline).filter(([name]) => !name.endsWith(EAGER_SUFFIX));
  return {
    files,
    total: sumSizes(current.values()),
    baseTotal: baseFiles === null || baseFiles.length === 0 ? null : sumSizes(baseFiles.map(([, size]) => size)),
  };
}

/**
 * Each HTML page at the app's root. `index.html` keeps the app's own name, so its baseline carries over. Throws when
 * `distDir` cannot be read.
 */
export function listEagerPages(app: string, distDir: string): { name: string; page: string }[] {
  return readdirSync(distDir)
    .filter(file => file.endsWith('.html'))
    .sort()
    .map(page => ({
      name: page === 'index.html' ? `${app}${EAGER_SUFFIX}` : `${app}/${page.slice(0, -'.html'.length)}${EAGER_SUFFIX}`,
      page,
    }));
}

function sumSizes(sizes: Iterable<Size>): Size {
  const sum = { raw: 0, br: 0, gz: 0 };
  for (const { raw, br, gz } of sizes) {
    sum.raw += raw;
    sum.br += br;
    sum.gz += gz;
  }
  return sum;
}

function getDistDir(app: string): string {
  return join('apps', app, 'dist');
}

function measureApps(apps: readonly string[]): Map<string, NamedSize> {
  return sumByName(apps.filter(app => existsSync(getDistDir(app))).flatMap(app => measureApp(app, getDistDir(app))));
}

function measureEagerSizes(app: string): { name: string; size: Size }[] {
  if (!existsSync(getDistDir(app))) {
    return [];
  }
  return listEagerPages(app, getDistDir(app)).flatMap(({ name, page }) => {
    try {
      const { raw, br, gz } = measureEagerPath(getDistDir(app), { page });
      return [{ name, size: { raw, br, gz } }];
    } catch (error) {
      // One page that cannot be measured leaves the rest of the report intact.
      console.error(
        `${name}: could not measure the eager path: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  });
}

function readBaseline(path: string): Baseline | null {
  if (!existsSync(path)) {
    return null;
  }
  // The file is this script's own `baseline` output.
  return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
}

function formatLine({ kind, name, count, size, base }: Params): string {
  return [kind, name, count, size.raw, size.br, size.gz, base?.raw ?? '', base?.br ?? '', base?.gz ?? ''].join('\t');
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'baseline' && rest.length > 0) {
    const baseline: Baseline = {};
    for (const [name, { raw, br, gz }] of measureApps(rest)) {
      baseline[name] = { raw, br, gz };
    }
    for (const { name, size } of rest.flatMap(measureEagerSizes)) {
      baseline[name] = size;
    }
    console.log(JSON.stringify(baseline, null, 2));
  } else if (mode === 'compare' && rest.length > 1) {
    // The length check above guarantees a first element, which the tuple type cannot learn from it.
    const [baselinePath, ...apps] = rest as [string, ...string[]];
    const baseline = readBaseline(baselinePath);
    const comparison = compare(measureApps(apps), baseline);
    for (const { name, size, base } of comparison.files) {
      console.log(formatLine({ kind: 'file', name, count: size.count, size, base }));
    }
    for (const { name, size } of apps.flatMap(measureEagerSizes)) {
      console.log(formatLine({ kind: 'eager', name, count: '-', size, base: baseline?.[name] ?? null }));
    }
    console.log(
      formatLine({ kind: 'total', name: 'total', count: '-', size: comparison.total, base: comparison.baseTotal }),
    );
  } else {
    console.error('usage: node scripts/bundleSizes.ts baseline <app>… | compare <baseline.json> <app>…');
    process.exit(1);
  }
}
