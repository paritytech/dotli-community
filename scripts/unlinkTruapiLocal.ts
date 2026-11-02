// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Undoes the local truapi link and reinstalls the published packages.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOTLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAMES = ['truapi', 'truapi-host', 'truapi-provider'];
const INSTALL_ROOTS = [
  resolve(DOTLI_ROOT, 'node_modules/@parity'),
  resolve(DOTLI_ROOT, 'apps/host/node_modules/@parity'),
  resolve(DOTLI_ROOT, 'packages/chains/node_modules/@parity'),
];

for (const root of INSTALL_ROOTS) {
  for (const name of PACKAGE_NAMES) {
    rmSync(resolve(root, name), { force: true, recursive: true });
  }
}

const result = spawnSync('npm', ['install'], {
  cwd: DOTLI_ROOT,
  stdio: 'inherit',
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const PRODUCT_ROOT = resolve(DOTLI_ROOT, process.env['E2E_PRODUCT_REPO'] ?? '../host-playground');
const NESTED_TRUAPI = resolve(PRODUCT_ROOT, 'node_modules/@parity/product-sdk-host/node_modules/@parity/truapi');
const LINKED_PRODUCT_SDK_HOST = resolve(PRODUCT_ROOT, 'node_modules/@parity/product-sdk-host');
if (
  existsSync(resolve(PRODUCT_ROOT, 'package.json')) &&
  (isSymlink(NESTED_TRUAPI) || isSymlink(LINKED_PRODUCT_SDK_HOST))
) {
  if (isSymlink(LINKED_PRODUCT_SDK_HOST)) {
    rmSync(LINKED_PRODUCT_SDK_HOST, { force: true, recursive: true });
  }
  rmSync(NESTED_TRUAPI, { force: true, recursive: true });
  const productInstall = spawnSync('yarn', ['install', '--force'], {
    cwd: PRODUCT_ROOT,
    stdio: 'inherit',
  });
  if (productInstall.status !== 0) {
    process.exit(productInstall.status ?? 1);
  }
}

function isSymlink(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}
