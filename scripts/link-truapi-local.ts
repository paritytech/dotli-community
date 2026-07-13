import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

run(["link", ...packages.map((pkg) => pkg.name)], dotliRoot);
