// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Sizes for the bundle size workflow: every emitted file by hash-stripped name, plus the eager path of each app's pages.
// `compare` prints tab-separated `kind name count raw br gz base_raw base_br base_gz`. The base fields come last so a
// shell `read` keeps the others in place when they are empty.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { measureEagerPath } from './eager-path-size.ts';

export interface Size {
  raw: number;
  br: number;
  gz: number;
}

export interface NamedSize extends Size {
  /** How many files share the name once their hashes are stripped. */
  count: number;
}

export type Baseline = Record<string, Size>;

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

/** Every file an app's build emits, sized raw and by its precompressed siblings (the raw size when there is none). */
export function measureApp(app: string, distDir: string): (Size & { name: string })[] {
  const files: (Size & { name: string })[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (!/\.(br|gz|map)$/.test(entry.name)) {
        const raw = statSync(path).size;
        const sibling = (ext: string): number => (existsSync(`${path}.${ext}`) ? statSync(`${path}.${ext}`).size : raw);
        files.push({ name: stripHash(`${app}/${relative(distDir, path)}`), raw, br: sibling('br'), gz: sibling('gz') });
      }
    }
  };
  walk(distDir);
  return files;
}

function total(sizes: Iterable<Size>): Size {
  const sum = { raw: 0, br: 0, gz: 0 };
  for (const { raw, br, gz } of sizes) {
    sum.raw += raw;
    sum.br += br;
    sum.gz += gz;
  }
  return sum;
}

export interface Comparison {
  files: { name: string; size: NamedSize; base: Size | null }[];
  total: Size;
  /** Main's whole build, files this build no longer has included, so an added, removed or renamed file shows. */
  baseTotal: Size | null;
}

export function compare(current: Map<string, NamedSize>, baseline: Baseline | null): Comparison {
  const files = [...current].map(([name, size]) => ({ name, size, base: baseline?.[name] ?? null }));
  const baseFiles =
    baseline === null ? null : Object.entries(baseline).filter(([name]) => !name.endsWith(EAGER_SUFFIX));
  return {
    files,
    total: total(current.values()),
    baseTotal: baseFiles === null || baseFiles.length === 0 ? null : total(baseFiles.map(([, size]) => size)),
  };
}

function distOf(app: string): string {
  return join('apps', app, 'dist');
}

function measureApps(apps: readonly string[]): Map<string, NamedSize> {
  return sumByName(apps.filter(app => existsSync(distOf(app))).flatMap(app => measureApp(app, distOf(app))));
}

/** Each HTML page at the app's root. `index.html` keeps the app's own name, so its baseline carries over. */
export function eagerPages(app: string, distDir: string): { name: string; page: string }[] {
  return readdirSync(distDir)
    .filter(file => file.endsWith('.html'))
    .sort()
    .map(page => ({
      name: page === 'index.html' ? `${app}${EAGER_SUFFIX}` : `${app}/${page.slice(0, -'.html'.length)}${EAGER_SUFFIX}`,
      page,
    }));
}

function eagerSizes(app: string): { name: string; size: Size }[] {
  if (!existsSync(distOf(app))) {
    return [];
  }
  return eagerPages(app, distOf(app)).flatMap(({ name, page }) => {
    try {
      const { raw, br, gz } = measureEagerPath(distOf(app), page);
      return [{ name, size: { raw, br, gz } }];
    } catch (err) {
      console.error(`${name}: could not measure the eager path: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  });
}

function line(kind: string, name: string, count: number | '-', size: Size, base: Size | null): string {
  return [kind, name, count, size.raw, size.br, size.gz, base?.raw ?? '', base?.br ?? '', base?.gz ?? ''].join('\t');
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'baseline' && rest.length > 0) {
    const baseline: Baseline = {};
    for (const [name, { raw, br, gz }] of measureApps(rest)) {
      baseline[name] = { raw, br, gz };
    }
    for (const { name, size } of rest.flatMap(eagerSizes)) {
      baseline[name] = size;
    }
    console.log(JSON.stringify(baseline, null, 2));
  } else if (mode === 'compare' && rest.length > 1) {
    const [baselinePath, ...apps] = rest as [string, ...string[]];
    const baseline = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline) : null;
    const comparison = compare(measureApps(apps), baseline);
    for (const { name, size, base } of comparison.files) {
      console.log(line('file', name, size.count, size, base));
    }
    for (const { name, size } of apps.flatMap(eagerSizes)) {
      console.log(line('eager', name, '-', size, baseline?.[name] ?? null));
    }
    console.log(line('total', 'total', '-', comparison.total, comparison.baseTotal));
  } else {
    console.error('usage: node scripts/bundle-sizes.ts baseline <app>… | compare <baseline.json> <app>…');
    process.exit(1);
  }
}
