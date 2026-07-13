import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
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

const result = spawnSync("bun", ["install"], {
  cwd: dotliRoot,
  stdio: "inherit",
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
