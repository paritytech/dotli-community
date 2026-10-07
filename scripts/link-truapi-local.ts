import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dotliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// dotli is either the `hosts/dotli` submodule of the truapi checkout or a clone next to it.
const truapiRoot = resolve(
  process.env['TRUAPI_REPO'] ??
    [resolve(dotliRoot, '../..'), resolve(dotliRoot, '../host-rust-core')].find(root =>
      existsSync(resolve(root, 'js/packages/truapi/package.json')),
    ) ??
    resolve(dotliRoot, '../..'),
);

const packages = [
  {
    name: '@parity/truapi',
    path: resolve(truapiRoot, 'js/packages/truapi'),
  },
  {
    name: '@parity/truapi-host',
    path: resolve(truapiRoot, 'js/packages/truapi-host'),
  },
  {
    name: '@parity/truapi-provider',
    path: resolve(truapiRoot, 'js/packages/truapi-provider'),
  },
] as const;

function assertPackage(expectedName: string, path: string): void {
  const packageJsonPath = resolve(path, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `Cannot find ${expectedName} at ${path}. Set TRUAPI_REPO=/path/to/truapi if dotli is not inside the truapi checkout.`,
    );
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name?: string;
  };
  if (packageJson.name !== expectedName) {
    throw new Error(`Expected ${packageJsonPath} to be ${expectedName}, got ${packageJson.name ?? '<missing>'}.`);
  }
}

// What `npm link` would do, minus the global registry detour and the reinstall it triggers.
for (const pkg of packages) {
  assertPackage(pkg.name, pkg.path);
  const target = resolve(dotliRoot, 'node_modules', pkg.name);
  rmSync(target, { force: true, recursive: true });
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(pkg.path, target, 'junction');
}

// Workspace-local installs shadow the root link, so drop them.
for (const [workspace, name] of [
  ['packages/ui', 'truapi'],
  ['packages/ui', 'truapi-host'],
  ['packages/resolver', 'truapi-provider'],
] as const) {
  rmSync(resolve(dotliRoot, workspace, 'node_modules/@parity', name), {
    force: true,
    recursive: true,
  });
}

// host-playground's product-sdk-host nests an older @parity/truapi. A second client over the same MessagePort
// collides on request ids, so point the nested one at this checkout.
const shouldLinkProduct = process.env['E2E_PRODUCT_REPO'] !== undefined || process.env['E2E_PRODUCT_URL'] !== undefined;
const productRoot = resolve(process.env['E2E_PRODUCT_REPO'] ?? resolve(dotliRoot, '../../../host-playground'));
if (shouldLinkProduct && existsSync(resolve(productRoot, 'package.json'))) {
  const nestedTruapi = resolve(productRoot, 'node_modules/@parity/product-sdk-host/node_modules/@parity/truapi');
  const nestedParent = dirname(nestedTruapi);
  if (!existsSync(resolve(productRoot, 'node_modules/@parity/product-sdk-host'))) {
    throw new Error(`Install host-playground dependencies before linking: ${productRoot}`);
  }
  rmSync(nestedTruapi, { force: true, recursive: true });
  mkdirSync(nestedParent, { recursive: true });
  symlinkSync(packages[0].path, nestedTruapi, 'junction');
  console.log(`Linked host-playground's nested @parity/truapi: ${productRoot}`);
} else if (shouldLinkProduct) {
  throw new Error(`E2E_PRODUCT_REPO does not contain package.json: ${productRoot}`);
}
