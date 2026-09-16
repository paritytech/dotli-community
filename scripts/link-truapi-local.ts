import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dotliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const truapiRoot = resolve(
  process.env.TRUAPI_REPO ?? resolve(dotliRoot, "../.."),
);
// CI keeps dotli's installed SDK untouched and only links the product fixture
// to the immutable distribution already checked into this repository.
const productVendorOnly = process.argv.includes("--product-vendor");

const packages = [
  {
    name: "@parity/truapi",
    path: productVendorOnly
      ? resolve(dotliRoot, "vendor/truapi")
      : resolve(truapiRoot, "js/packages/truapi"),
  },
  {
    name: "@parity/truapi-host",
    path: resolve(truapiRoot, "js/packages/truapi-host"),
  },
];

function run(args: string[], cwd: string): void {
  const result = spawnSync("bun", args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function assertPackage(expectedName: string, path: string): void {
  const packageJsonPath = resolve(path, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `Cannot find ${expectedName} at ${path}. Set TRUAPI_REPO=/path/to/truapi if dotli is not inside the truapi checkout.`,
    );
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
  };
  if (packageJson.name !== expectedName) {
    throw new Error(
      `Expected ${packageJsonPath} to be ${expectedName}, got ${packageJson.name ?? "<missing>"}.`,
    );
  }
}

if (productVendorOnly) {
  assertPackage(packages[0].name, packages[0].path);
} else {
  for (const pkg of packages) {
    assertPackage(pkg.name, pkg.path);
    run(["link"], pkg.path);
  }

  const packageNames = packages.map((pkg) => pkg.name);
  run(["link", ...packageNames], dotliRoot);

  for (const name of ["truapi", "truapi-host"]) {
    for (const workspace of ["packages/ui", "apps/sandbox"]) {
      rmSync(resolve(dotliRoot, workspace, "node_modules/@parity", name), {
        force: true,
        recursive: true,
      });
    }
  }
}

// host-playground's published product-sdk-host currently nests an older
// @parity/truapi. The local E2E must use one current client instance; loading
// a second client over the same MessagePort causes request-id collisions and
// reproduces the alias card's stuck-pending symptom. Point that nested runtime
// at this checkout when the local product checkout is available. Link the
// product root too so every consumer resolves the same client instance.
const shouldLinkProduct =
  productVendorOnly ||
  process.env.E2E_PRODUCT_REPO !== undefined ||
  process.env.E2E_PRODUCT_URL !== undefined;
const productRoot = resolve(
  process.env.E2E_PRODUCT_REPO ??
    resolve(dotliRoot, "../../../host-playground"),
);
if (shouldLinkProduct && existsSync(resolve(productRoot, "package.json"))) {
  const productTruapiPaths = [
    resolve(productRoot, "node_modules/@parity/truapi"),
    resolve(
      productRoot,
      "node_modules/@parity/product-sdk-host/node_modules/@parity/truapi",
    ),
  ];
  if (
    !existsSync(resolve(productRoot, "node_modules/@parity/product-sdk-host"))
  ) {
    throw new Error(
      `Install host-playground dependencies before linking: ${productRoot}`,
    );
  }
  for (const path of productTruapiPaths) {
    rmSync(path, { force: true, recursive: true });
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(packages[0].path, path, "junction");
  }
  console.log(`Linked host-playground's @parity/truapi: ${productRoot}`);
} else if (shouldLinkProduct) {
  throw new Error(
    `E2E_PRODUCT_REPO does not contain package.json: ${productRoot}`,
  );
}
