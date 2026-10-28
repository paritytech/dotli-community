// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Links a local truapi checkout's JS packages into node_modules in place of the published ones.

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOTLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// dotli is either the `hosts/dotli` submodule of the truapi checkout or a clone next to it.
const TRUAPI_ROOT = resolve(
  process.env['TRUAPI_REPO'] ??
    [resolve(DOTLI_ROOT, '../..'), resolve(DOTLI_ROOT, '../host-rust-core')].find(root =>
      existsSync(resolve(root, 'js/packages/truapi/package.json')),
    ) ??
    resolve(DOTLI_ROOT, '../..'),
);

const PACKAGES = [
  {
    name: '@parity/truapi',
    path: resolve(TRUAPI_ROOT, 'js/packages/truapi'),
  },
  {
    name: '@parity/truapi-host',
    path: resolve(TRUAPI_ROOT, 'js/packages/truapi-host'),
  },
  {
    name: '@parity/truapi-provider',
    path: resolve(TRUAPI_ROOT, 'js/packages/truapi-provider'),
  },
] as const;

function assertPackage(expectedName: string, path: string): void {
  const packageJsonPath = resolve(path, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `Cannot find ${expectedName} at ${path}. Set TRUAPI_REPO=/path/to/truapi if dotli is not inside the truapi checkout.`,
    );
  }

  // A package.json is an object, and only its `name` is read.
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name?: string;
  };
  if (packageJson.name !== expectedName) {
    throw new Error(`Expected ${packageJsonPath} to be ${expectedName}, got ${packageJson.name ?? '<missing>'}.`);
  }
}

// What `npm link` would do, minus the global registry detour and the reinstall it triggers.
for (const truapiPackage of PACKAGES) {
  assertPackage(truapiPackage.name, truapiPackage.path);
  const target = resolve(DOTLI_ROOT, 'node_modules', truapiPackage.name);
  rmSync(target, { force: true, recursive: true });
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(truapiPackage.path, target, 'junction');
}

// Workspace-local installs shadow the root link, so drop them.
for (const [workspace, name] of [
  ['apps/host', 'truapi'],
  ['apps/host', 'truapi-host'],
  ['packages/chains', 'truapi-provider'],
] as const) {
  rmSync(resolve(DOTLI_ROOT, workspace, 'node_modules/@parity', name), {
    force: true,
    recursive: true,
  });
}

// host-playground's product-sdk-host nests an older @parity/truapi. A second client over the same MessagePort
// collides on request ids, so point the nested one at this checkout.
const SHOULD_LINK_PRODUCT =
  process.env['E2E_PRODUCT_REPO'] !== undefined || process.env['E2E_PRODUCT_URL'] !== undefined;
const PRODUCT_ROOT = resolve(DOTLI_ROOT, process.env['E2E_PRODUCT_REPO'] ?? '../host-playground');
if (SHOULD_LINK_PRODUCT && existsSync(resolve(PRODUCT_ROOT, 'package.json'))) {
  const nestedTruapi = resolve(PRODUCT_ROOT, 'node_modules/@parity/product-sdk-host/node_modules/@parity/truapi');
  const nestedParent = dirname(nestedTruapi);
  if (!existsSync(resolve(PRODUCT_ROOT, 'node_modules/@parity/product-sdk-host'))) {
    throw new Error(`Install host-playground dependencies before linking: ${PRODUCT_ROOT}`);
  }
  rmSync(nestedTruapi, { force: true, recursive: true });
  mkdirSync(nestedParent, { recursive: true });
  symlinkSync(PACKAGES[0].path, nestedTruapi, 'junction');
  console.log(`Linked host-playground's nested @parity/truapi: ${PRODUCT_ROOT}`);
} else if (SHOULD_LINK_PRODUCT) {
  throw new Error(`E2E_PRODUCT_REPO does not contain package.json: ${PRODUCT_ROOT}`);
}
