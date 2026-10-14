// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Regenerates THIRD_PARTY_NOTICES.md from the installed dependency tree. Run after dependency changes.
// INTRO speaks for the license families listed, so a license missing from SECTIONS fails the run. Review what it asks
// of the project, then add it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md');

/** The notice's sections, in order: permissive first, then the rest. */
const SECTIONS = [
  'MIT',
  'Apache-2.0',
  'Apache-2.0 OR MIT',
  'Apache-2.0 AND MIT',
  'Unlicense OR Apache-2.0',
  'MIT AND BSD-3-Clause',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'Python-2.0',
  'MIT OR CC0-1.0',
  'CC0-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'GPL-3.0-or-later WITH Classpath-exception-2.0',
  'LGPL-3.0-or-later',
  'MPL-2.0',
  'FSL-1.1-MIT',
] as const;

/** Spellings of a section's expression that packages declare. */
const ALIASES: Record<string, string> = {
  '(MIT OR CC0-1.0)': 'MIT OR CC0-1.0',
  'MIT OR Apache-2.0': 'Apache-2.0 OR MIT',
  '(Apache-2.0 OR MIT)': 'Apache-2.0 OR MIT',
  'MIT AND Apache-2.0': 'Apache-2.0 AND MIT',
  '(Unlicense OR Apache-2.0)': 'Unlicense OR Apache-2.0',
  '(MIT AND BSD-3-Clause)': 'MIT AND BSD-3-Clause',
};

const INTRO = `# Third-Party Notices

dot.li (dotli) is licensed under the GNU Affero General Public License v3.0 (\`AGPL-3.0-only\`). This product depends on
and, where applicable, bundles the third-party open-source packages listed below, each of which remains under its own
license. Packages are grouped by SPDX license identifier and listed alphabetically. Copyright and permission notices for
each package are retained in its distribution under \`node_modules\`.

GPL-family components (GPL-3.0 with the Classpath linking exception) are compatible with this project's AGPL-3.0
outbound license. The shipped \`@parity/polkavm-browser-runtime\` artifacts remain under MPL-2.0. Their full license,
dependency notices, per-file hashes and source provenance are served beside the runtime. Build-time-only tooling under
source-available FSL-1.1-MIT terms is not redistributed as part of the application.

The vendored \`@parity/truapi\` and \`@parity/truapi-host\` packages are MIT-licensed. Their license texts are retained
in \`vendor/truapi/LICENSE\` and \`vendor/truapi-host/LICENSE\`, including the production web Wasm distribution.
Exact source revision, package versions and artifact hashes are recorded in \`vendor/truapi-host.lock.json\`.`;

interface LockEntry {
  name?: string;
  license?: unknown;
  link?: boolean;
}

interface Lockfile {
  packages: Record<string, LockEntry>;
}

function sectionOf(license: unknown, path: string): string {
  if (typeof license !== 'string') {
    throw new Error(`${path}: no SPDX license in package-lock.json (${JSON.stringify(license)})`);
  }
  const section = ALIASES[license] ?? license;
  if (!(SECTIONS as readonly string[]).includes(section)) {
    throw new Error(
      `${path}: license ${license} is not reviewed; add it to SECTIONS in scripts/third-party-notices.ts`,
    );
  }
  return section;
}

/** Each installed third-party package name, with the sections its versions fall under. */
function installedPackages(): Map<string, Set<string>> {
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')) as Lockfile;
  const packages = new Map<string, Set<string>>();
  for (const [path, entry] of Object.entries(lock.packages)) {
    const at = path.lastIndexOf('node_modules/');
    // The root and workspace folders, the links to workspaces, and optional
    // packages this platform did not install.
    if (at === -1 || entry.link === true || !existsSync(join(REPO_ROOT, path))) {
      continue;
    }
    const name = entry.name ?? path.slice(at + 'node_modules/'.length);
    if (name.startsWith('@dotli/')) {
      continue;
    }
    const sections = packages.get(name) ?? new Set<string>();
    sections.add(sectionOf(entry.license, path));
    packages.set(name, sections);
  }
  return packages;
}

function render(packages: Map<string, Set<string>>): string {
  const bySection = new Map<string, string[]>();
  for (const [name, sections] of packages) {
    for (const section of sections) {
      bySection.set(section, [...(bySection.get(section) ?? []), name]);
    }
  }
  const note =
    `> Generated from the resolved dependency tree (${String(packages.size)} distinct third-party packages) by ` +
    '`scripts/third-party-notices.ts`. Platform-specific binary packages (for example `*-darwin-arm64`, `@esbuild/*`, ' +
    '`@rolldown/*`) reflect the build host; other platforms resolve their own equivalents under the same licenses. ' +
    'Regenerate after dependency changes.';
  const sections = SECTIONS.flatMap(section => {
    const names = bySection.get(section);
    return names === undefined ? [] : [`## ${section}\n\n${names.sort().join(', ')}`];
  });
  return [INTRO, note, ...sections].join('\n\n') + '\n';
}

const markdown = render(installedPackages());
const options = (await resolveConfig(OUTPUT)) ?? {};
writeFileSync(OUTPUT, await format(markdown, { ...options, filepath: OUTPUT }));
console.log(`Wrote ${OUTPUT}`);
