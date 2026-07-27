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

const packages = [
  {
    name: "@parity/truapi",
    path: resolve(truapiRoot, "js/packages/truapi"),
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

for (const pkg of packages) {
  assertPackage(pkg.name, pkg.path);
  run(["link"], pkg.path);
}

const packageNames = packages.map((pkg) => pkg.name);
run(["link", ...packageNames], dotliRoot);

for (const name of ["truapi", "truapi-host"]) {
  rmSync(resolve(dotliRoot, "packages/ui/node_modules/@parity", name), {
    force: true,
    recursive: true,
  });
}

// host-playground's published product-sdk-host currently nests an older
// @parity/truapi. The local E2E must use one current client instance; loading
// a second client over the same MessagePort causes request-id collisions and
// reproduces the alias card's stuck-pending symptom. Point that nested runtime
// at this checkout when the local product checkout is available.
const shouldLinkProduct =
  process.env.E2E_PRODUCT_REPO !== undefined ||
  process.env.E2E_PRODUCT_URL !== undefined;
const productRoot = resolve(
  process.env.E2E_PRODUCT_REPO ??
    resolve(dotliRoot, "../../../host-playground"),
);
if (shouldLinkProduct && existsSync(resolve(productRoot, "package.json"))) {
  const nestedTruapi = resolve(
    productRoot,
    "node_modules/@parity/product-sdk-host/node_modules/@parity/truapi",
  );
  const nestedParent = dirname(nestedTruapi);
  if (
    !existsSync(resolve(productRoot, "node_modules/@parity/product-sdk-host"))
  ) {
    throw new Error(
      `Install host-playground dependencies before linking: ${productRoot}`,
    );
  }
  rmSync(nestedTruapi, { force: true, recursive: true });
  mkdirSync(nestedParent, { recursive: true });
  symlinkSync(packages[0].path, nestedTruapi, "junction");
  console.log(`Linked host-playground's nested @parity/truapi: ${productRoot}`);
} else if (shouldLinkProduct) {
  throw new Error(
    `E2E_PRODUCT_REPO does not contain package.json: ${productRoot}`,
  );
}
