import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv[2] === "--check";
if (process.argv.length > 2 && !checkOnly) {
  throw new Error("usage: sync-pvm-runtime-assets.mjs [--check]");
}
const lock = JSON.parse(
  await readFile(resolve(root, "scripts/pvm-runtime.lock.json"), "utf8"),
);
const temporary = await mkdtemp(resolve(tmpdir(), "dotli-pvm-assets-"));
let checkout = process.env.PVM_BRIDGE_ROOT;
try {
  if (!checkout) {
    checkout = resolve(temporary, "host-rust-core");
    execFileSync("git", ["init", "-q", checkout]);
    execFileSync("git", [
      "-C",
      checkout,
      "fetch",
      "-q",
      "--depth=1",
      lock.bridgeRepository,
      lock.bridgeRevision,
    ]);
    execFileSync("git", [
      "-C",
      checkout,
      "checkout",
      "-q",
      "--detach",
      "FETCH_HEAD",
    ]);
  }
  const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (head !== lock.bridgeRevision) {
    throw new Error(
      `bridge checkout ${head} does not match ${lock.bridgeRevision}`,
    );
  }

  const exportedRoot = resolve(temporary, "exported");
  const exported = spawnSync(
    "cargo",
    [
      "run",
      "--locked",
      "--manifest-path",
      resolve(checkout, "Cargo.toml"),
      "-p",
      "truapi-pvm-host",
      "--features",
      "browser-assets",
      "--bin",
      "pvm-assets-export",
      "--",
      "--output",
      exportedRoot,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (exported.status !== 0) process.exit(exported.status ?? 1);

  const mappings = new Map([
    ["pvm-browser-runtime.wasm", "pvm-browser-runtime.wasm"],
    ["pvm-worker.js", "pvm-wasm-worker.js"],
    ["pvm-gpu-worker.js", "pvm-gpu-worker.js"],
  ]);
  const destination = resolve(root, "apps/sandbox/public/pvm-runtime");
  const source = `PolkaVM App v2 browser runtime
Bridge repository: ${lock.bridgeRepository}
Bridge commit: ${lock.bridgeRevision}
Runtime repository: ${lock.runtimeRepository}
Runtime commit: ${lock.runtimeRevision}
Release: ${lock.releaseTag}

Bridge-owned artifacts:
${[...mappings.values()].map((path) => `- ${path}`).join("\n")}
`;

  for (const [exportedName, destinationName] of mappings) {
    const bytes = await readFile(resolve(exportedRoot, exportedName));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== lock.assets[destinationName]) {
      throw new Error(`${destinationName} has unexpected digest ${actual}`);
    }
    const path = resolve(destination, destinationName);
    if (checkOnly) {
      if (!(await readFile(path)).equals(bytes)) {
        throw new Error(`stale PVM runtime asset: ${path}`);
      }
    } else {
      await copyFile(resolve(exportedRoot, exportedName), path);
    }
  }
  const sourcePath = resolve(destination, "SOURCE");
  if (checkOnly) {
    if ((await readFile(sourcePath, "utf8")) !== source) {
      throw new Error(`stale PVM runtime provenance: ${sourcePath}`);
    }
  } else {
    await writeFile(sourcePath, source);
  }
  console.log(
    `${checkOnly ? "Verified" : "Synchronized"} bridge-owned PVM assets from ${lock.bridgeRevision}`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}