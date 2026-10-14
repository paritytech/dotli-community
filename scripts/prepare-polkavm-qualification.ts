// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface ArtifactPins {
  cid: string;
  carSha256: string;
  manifestSha256: string;
  programSha256: string;
}
interface QualificationLock {
  schemaVersion: number;
  source: { repository: string; revision: string; guestSdkRevision: string };
  build: {
    playgroundToolchain: string;
    doomToolchain: string;
    polkatoolVersion: string;
    packagerVersion: string;
  };
  freedoom: {
    version: string;
    url: string;
    archiveSha256: string;
    freedoom1Sha256: string;
    freedoom2Sha256: string;
  };
  tools?: Record<string, string>;
  artifacts?: Record<FixtureName, ArtifactPins>;
}
type FixtureName = 'playground' | 'freedoom1' | 'freedoom2';
interface Fixture extends ArtifactPins {
  car: string;
  manifest: string;
  productId: string;
  mountPath?: string;
}
interface Manifest {
  $v: number;
  kind: string;
  runtime: { kind: string; abiVersion: number; entrypoint: string };
  capabilities: Record<string, unknown>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = resolve(root, 'apps/host/tests/functional/fixtures/polkavm/qualification.lock.json');
const destination = resolve(root, 'dist/polkavm-qualification');
const cache = resolve(destination, '.cache');
const build = resolve(cache, 'build');
const staging = resolve(cache, 'output');
let source: string | undefined;
let recordArtifacts = false;
for (let i = 2; i < process.argv.length; i++) {
  const argument = process.argv[i];
  const next = process.argv[i + 1];
  if (argument === '--source' && next !== undefined && next !== '' && source === undefined) {
    source = resolve(next);
    i++;
  } else if (argument === '--record-artifacts' && !recordArtifacts) {
    recordArtifacts = true;
  } else {
    throw new Error('usage: prepare-polkavm-qualification.ts [--source <clean-checkout>] [--record-artifacts]');
  }
}
const lock = JSON.parse(await readFile(lockPath, 'utf8')) as QualificationLock;
if (
  lock.schemaVersion !== 1 ||
  !/^[a-f0-9]{40}$/.test(lock.source.revision) ||
  !/^[a-f0-9]{40}$/.test(lock.source.guestSdkRevision)
) {
  throw new Error('Invalid qualification source lock');
}
if (!recordArtifacts && (!lock.artifacts || !lock.tools)) {
  throw new Error(
    'Artifact pins are missing: run with --record-artifacts once, review the lock, then rerun without that flag',
  );
}

function command(executable: string, args: string[], cwd = root, env = process.env, capture = false): string {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} failed (${String(result.status)})${capture ? `: ${result.stderr}` : ''}`,
    );
  }
  return capture ? result.stdout.trim() : '';
}
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
async function digest(path: string): Promise<string> {
  return sha256(await readFile(path));
}
function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
}
function executable(name: string): string {
  return command('which', [name], root, process.env, true);
}

await mkdir(cache, { recursive: true });
const mutex = resolve(cache, 'preparing');
await mkdir(mutex).catch(() => {
  throw new Error(
    `Preparation already running, or interrupted previously: ${mutex}. Remove that directory only after confirming no preparation is running.`,
  );
});
try {
  if (source !== undefined) {
    equal(command('git', ['rev-parse', 'HEAD'], source, process.env, true), lock.source.revision, 'Source revision');
    equal(
      command('git', ['status', '--porcelain', '--untracked-files=normal'], source, process.env, true),
      '',
      'Source checkout cleanliness',
    );
  } else {
    source = resolve(cache, 'repository.git');
    command('git', ['init', '--bare', source]);
    command('git', ['fetch', '--depth=1', lock.source.repository, lock.source.revision], source);
    equal(
      command('git', ['rev-parse', 'FETCH_HEAD'], source, process.env, true),
      lock.source.revision,
      'Fetched revision',
    );
  }

  // Archive the commit, not the working tree or ignored sibling build outputs.
  const archive = resolve(cache, 'source.tar');
  command('git', ['archive', '--format=tar', `--output=${archive}`, lock.source.revision], source);
  await rm(build, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(build, { recursive: true });
  await mkdir(staging, { recursive: true });
  command('tar', ['-xf', archive, '-C', build]);
  const sdkManifest = await readFile(resolve(build, 'crates/polkavm-truapi/Cargo.toml'), 'utf8');
  const sdkPins = [...sdkManifest.matchAll(/rev = "([a-f0-9]{40})"/g)].map(match => match[1]);
  equal(sdkPins, [lock.source.guestSdkRevision, lock.source.guestSdkRevision], 'Guest SDK revisions');
  const cargoLocks = ['apps/pvm-truapi-playground/Cargo.lock', 'apps/doom/Cargo.lock'];
  const dependencyPaths = [...cargoLocks, 'package-lock.json'];
  const dependencyDigests = await Promise.all(dependencyPaths.map(path => digest(resolve(build, path))));

  const clang = executable(process.env['PVM_CLANG'] ?? 'clang');
  const llvmAr = executable(process.env['PVM_LLVM_AR'] ?? resolve(dirname(clang), 'llvm-ar'));
  const llvmRanlib = executable(process.env['PVM_LLVM_RANLIB'] ?? resolve(dirname(clang), 'llvm-ranlib'));
  const cargo = executable('cargo');
  const tools = {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    npm: command('npm', ['--version'], root, process.env, true),
    polkatool: command('polkatool', ['--version'], root, process.env, true),
    clang: command(clang, ['--version'], root, process.env, true).split('\n', 1).join(''),
    llvmAr: command(llvmAr, ['--version'], root, process.env, true),
    llvmRanlib: command(llvmRanlib, ['--version'], root, process.env, true),
    playgroundRustc: command(
      'rustup',
      ['run', lock.build.playgroundToolchain, 'rustc', '--version'],
      root,
      process.env,
      true,
    ),
    doomRustc: command('rustup', ['run', lock.build.doomToolchain, 'rustc', '--version'], root, process.env, true),
  };
  if (!tools.polkatool.endsWith(` ${lock.build.polkatoolVersion}`)) {
    throw new Error(`Requires polkatool ${lock.build.polkatoolVersion}`);
  }
  if (!recordArtifacts) {
    equal(tools, lock.tools, 'Build toolchain provenance');
  }

  // The pinned Doom entrypoint omits --locked. Enforce it without editing source.
  const bin = resolve(cache, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    resolve(bin, 'cargo'),
    '#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "--locked" ]; then exec "$QUALIFICATION_CARGO" "$@"; fi\ndone\nexec "$QUALIFICATION_CARGO" "$@" --locked\n',
    { mode: 0o755 },
  );
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(RUST|CARGO|PVM_|DOOM_|FREEDOOM_|CC$|CXX$|CFLAGS|CPPFLAGS|CXXFLAGS|AR$|RANLIB$)/.test(key) ||
        ['CARGO_HOME', 'RUSTUP_HOME'].includes(key),
    ),
  );
  const env = {
    ...inherited,
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    QUALIFICATION_CARGO: cargo,
    RUSTC_WRAPPER: '',
    RUSTC_WORKSPACE_WRAPPER: '',
    RUSTFLAGS: `--remap-path-prefix=${build}=/workspace --remap-path-prefix=${process.env['CARGO_HOME'] ?? resolve(homedir(), '.cargo')}=/cargo --remap-path-prefix=${process.env['RUSTUP_HOME'] ?? resolve(homedir(), '.rustup')}=/rustup`,
    CFLAGS: `-ffile-prefix-map=${build}=/workspace`,
    PVM_RUST_TOOLCHAIN: lock.build.playgroundToolchain,
    PVM_CLANG: clang,
    PVM_LLVM_AR: llvmAr,
    PVM_LLVM_RANLIB: llvmRanlib,
    FREEDOOM_ARCHIVE: resolve(cache, `freedoom-${lock.freedoom.version}.zip`),
    FREEDOOM_URL: lock.freedoom.url,
    SOURCE_DATE_EPOCH: command('git', ['show', '-s', '--format=%ct', lock.source.revision], source, process.env, true),
    TZ: 'UTC',
    LC_ALL: 'C',
  };
  command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], build, env);
  command(process.execPath, [resolve(build, 'node_modules/patch-package/index.js')], build, env);
  const packagerManifest = JSON.parse(
    await readFile(resolve(build, 'node_modules/bulletin-deploy/package.json'), 'utf8'),
  ) as { version: string; exports: { '.': { import: string } } };
  equal(packagerManifest.version, lock.build.packagerVersion, 'CAR packager version');
  // This module exists only in the freshly installed, revision-selected source
  // checkout; a static import would resolve this repository's dependencies.
  const entry = resolve(build, 'node_modules/bulletin-deploy', packagerManifest.exports['.'].import);
  const { merkleizeJS } = (await import(pathToFileURL(entry).href)) as {
    merkleizeJS: (directory: string) => Promise<{ carBytes: Uint8Array; cid: string }>;
  };
  const fixtures = {} as Record<FixtureName, Fixture>;
  const artifactPins = {} as Record<FixtureName, ArtifactPins>;
  async function packageFixture(name: FixtureName, productId: string, mountPath?: string): Promise<void> {
    const app = name === 'playground' ? 'pvm-truapi-playground' : 'doom';
    const directory = resolve(staging, name);
    const bundle = resolve(directory, 'bundle');
    await mkdir(directory, { recursive: true });
    await cp(resolve(build, 'apps', app, 'bundle'), bundle, { recursive: true });
    const manifest = JSON.parse(await readFile(resolve(bundle, 'manifest.json'), 'utf8')) as Manifest;
    if (
      manifest.$v !== 2 ||
      manifest.kind !== 'app' ||
      manifest.runtime.kind !== 'polkavm' ||
      manifest.runtime.abiVersion !== 1
    ) {
      throw new Error(`${name}: unexpected guest manifest ABI`);
    }
    if (mountPath !== undefined) {
      manifest.capabilities['fileInput'] = {
        abiVersion: 1,
        handlers: [{ id: 'iwad', label: 'Freedoom IWAD', extensions: ['.wad'], maxBytes: 64 * 1024 * 1024, mountPath }],
      };
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(resolve(bundle, 'manifest.json'), manifestBytes);
    // Use the source's locked UnixFS importer: game/ and LICENSES/ are actual
    // directory nodes, never slash-containing links in a flat root directory.
    const { carBytes, cid } = await merkleizeJS(bundle);
    const pins = {
      cid,
      carSha256: sha256(carBytes),
      manifestSha256: sha256(manifestBytes),
      programSha256: await digest(resolve(bundle, manifest.runtime.entrypoint)),
    };
    if (!recordArtifacts) {
      equal(pins, lock.artifacts?.[name], `${name} artifact pins`);
    }
    artifactPins[name] = pins;
    fixtures[name] = {
      car: `${name}/app.car`,
      manifest: `${name}/manifest.json`,
      productId,
      ...pins,
      ...(mountPath !== undefined ? { mountPath } : {}),
    };
    await writeFile(resolve(directory, 'app.car'), carBytes);
    await writeFile(resolve(directory, 'manifest.json'), manifestBytes);
    await rm(bundle, { recursive: true });
  }

  command('bash', ['apps/pvm-truapi-playground/package.sh'], build, env);
  await packageFixture('playground', 'pvm-truapi-playground.paseo');
  const uploads = {} as Record<'freedoom1' | 'freedoom2', { path: string; sha256: string }>;
  await mkdir(resolve(staging, 'uploads/LICENSES'), { recursive: true });
  for (const campaign of ['freedoom1', 'freedoom2'] as const) {
    // The same pinned engine selects the campaign by filename, not WAD bytes.
    // Each invocation creates a fresh bundle containing only the selected IWAD.
    command('bash', ['scripts/package-doom-app.sh', 'doom', `${campaign}.wad`], build, env);
    equal(await digest(env.FREEDOOM_ARCHIVE), lock.freedoom.archiveSha256, 'Freedoom archive');
    const wad = resolve(build, `apps/doom/bundle/game/${campaign}.wad`);
    const wadSha256 = await digest(wad);
    equal(wadSha256, lock.freedoom[`${campaign}Sha256`], `${campaign} IWAD`);
    const path = `uploads/${campaign}.wad`;
    await copyFile(wad, resolve(staging, path));
    uploads[campaign] = { path, sha256: wadSha256 };
    await packageFixture(campaign, campaign === 'freedoom1' ? 'doom.paseo' : 'doom2.paseo', `game/${campaign}.wad`);
  }
  for (const name of ['COPYING.txt', 'CREDITS.txt', 'CREDITS-MUSIC.txt']) {
    await copyFile(resolve(build, 'content/freedoom/bundle', name), resolve(staging, 'uploads/LICENSES', name));
  }
  equal(
    await Promise.all(dependencyPaths.map(path => digest(resolve(build, path)))),
    dependencyDigests,
    'Dependency lockfiles after build',
  );
  equal(artifactPins.freedoom1.programSha256, artifactPins.freedoom2.programSha256, 'Shared Doom engine');
  if (recordArtifacts) {
    lock.tools = tools;
    lock.artifacts = artifactPins;
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
  // Publish the index last. A failed preparation never advertises partial output.
  await rm(resolve(destination, 'fixtures.json'), { force: true });
  for (const name of ['playground', 'freedoom1', 'freedoom2', 'uploads']) {
    await rm(resolve(destination, name), { recursive: true, force: true });
    await rename(resolve(staging, name), resolve(destination, name));
  }
  await writeFile(
    resolve(destination, 'fixtures.json'),
    `${JSON.stringify({ schemaVersion: 1, source: lock.source, tools, fixtures, uploads }, null, 2)}\n`,
  );
  console.log(`Verified qualification fixtures: ${resolve(destination, 'fixtures.json')}`);
  if (recordArtifacts) {
    console.log(`Recorded artifact pins in ${lockPath}; review them, then rerun without --record-artifacts.`);
  }
} finally {
  await rm(mutex, { recursive: true, force: true });
}
