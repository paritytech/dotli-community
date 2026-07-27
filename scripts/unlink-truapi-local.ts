import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dotliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageNames = ["truapi", "truapi-host"];
const installRoots = [
  resolve(dotliRoot, "node_modules/@parity"),
  resolve(dotliRoot, "packages/ui/node_modules/@parity"),
];

for (const root of installRoots) {
  for (const name of packageNames) {
    rmSync(resolve(root, name), { force: true, recursive: true });
  }
}

const result = spawnSync("bun", ["install", "--force"], {
  cwd: dotliRoot,
  stdio: "inherit",
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const productRoot = resolve(
  process.env.E2E_PRODUCT_REPO ??
    resolve(dotliRoot, "../../../host-playground"),
);
const nestedTruapi = resolve(
  productRoot,
  "node_modules/@parity/product-sdk-host/node_modules/@parity/truapi",
);
const linkedProductSdkHost = resolve(
  productRoot,
  "node_modules/@parity/product-sdk-host",
);
const isSymlink = (path: string): boolean =>
  lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
if (
  existsSync(resolve(productRoot, "package.json")) &&
  (isSymlink(nestedTruapi) || isSymlink(linkedProductSdkHost))
) {
  if (isSymlink(linkedProductSdkHost)) {
    rmSync(linkedProductSdkHost, { force: true, recursive: true });
  }
  rmSync(nestedTruapi, { force: true, recursive: true });
  const productInstall = spawnSync("yarn", ["install", "--force"], {
    cwd: productRoot,
    stdio: "inherit",
  });
  if (productInstall.status !== 0) {
    process.exit(productInstall.status ?? 1);
  }
}
