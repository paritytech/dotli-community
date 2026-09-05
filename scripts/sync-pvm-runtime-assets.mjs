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
const destination = resolve(root, "apps/sandbox/public/pvm-runtime");

function checkoutRevision(environment, directory, repository, revision) {
  let checkout = process.env[environment];
  if (!checkout) {
    checkout = resolve(temporary, directory);
    execFileSync("git", ["init", "-q", checkout]);
    execFileSync("git", [
      "-C",
      checkout,
      "fetch",
      "-q",
      "--depth=1",
      repository,
      revision,
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
  if (head !== revision) {
    throw new Error(`${directory} checkout ${head} does not match ${revision}`);
  }
  return checkout;
}

function exportAssets(checkout, output, cargoArguments) {
  const exported = spawnSync(
    "cargo",
    [...cargoArguments, "--", "--output", output],
    { cwd: root, stdio: "inherit" },
  );
  if (exported.status !== 0) {
    throw new Error(
      `asset export failed (${exported.signal ?? exported.status ?? "spawn error"})`,
    );
  }
}

async function syncAsset(exportedRoot, exportedName, destinationName) {
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

try {
  const bridgeCheckout = checkoutRevision(
    "PVM_BRIDGE_ROOT",
    "host-rust-core",
    lock.bridgeRepository,
    lock.bridgeRevision,
  );
  const bridgeExportedRoot = resolve(temporary, "bridge-exported");
  exportAssets(bridgeCheckout, bridgeExportedRoot, [
    "run",
    "--locked",
    "--manifest-path",
    resolve(bridgeCheckout, "Cargo.toml"),
    "-p",
    "truapi-pvm-host",
    "--features",
    "browser-assets",
    "--bin",
    "pvm-assets-export",
  ]);

  const runtimeCheckout = checkoutRevision(
    "PVM_RUNTIME_ROOT",
    "pvm-host-runtime",
    lock.runtimeRepository,
    lock.runtimeRevision,
  );
  const runtimeExportedRoot = resolve(temporary, "runtime-exported");
  exportAssets(runtimeCheckout, runtimeExportedRoot, [
    "run",
    "--locked",
    "--manifest-path",
    resolve(runtimeCheckout, "Cargo.toml"),
    "-p",
    "pvm-assets-export",
    "--bin",
    "pvm-assets-export",
  ]);

  const bridgeMappings = new Map([
    ["pvm-browser-runtime.wasm", "pvm-browser-runtime.wasm"],
    ["pvm-worker.js", "pvm-wasm-worker.js"],
  ]);
  for (const [exportedName, destinationName] of bridgeMappings) {
    await syncAsset(bridgeExportedRoot, exportedName, destinationName);
  }
  // Keep the reviewed core/GPU release while evolving the computer adapter.
  const computerCheckout = checkoutRevision(
    "PVM_COMPUTER_RUNTIME_ROOT",
    "pvm-host-runtime-computer",
    lock.runtimeRepository,
    lock.computerRuntimeRevision,
  );
  const computerExportedRoot = resolve(temporary, "computer-exported");
  exportAssets(computerCheckout, computerExportedRoot, [
    "run",
    "--locked",
    "--manifest-path",
    resolve(computerCheckout, "Cargo.toml"),
    "-p",
    "pvm-assets-export",
    "--bin",
    "pvm-assets-export",
  ]);
  await syncAsset(
    runtimeExportedRoot,
    "pvm-gpu-worker.js",
    "pvm-gpu-worker.js",
  );
  await syncAsset(computerExportedRoot, "pvm-computer.js", "pvm-computer.js");

  const source = `PolkaVM App v2 browser runtime
Bridge repository: ${lock.bridgeRepository}
Bridge commit: ${lock.bridgeRevision}
Runtime repository: ${lock.runtimeRepository}
Runtime commit: ${lock.runtimeRevision}
Computer runtime commit: ${lock.computerRuntimeRevision}
Release: ${lock.releaseTag}
Provenance: ${lock.provenance}

Bridge-owned artifacts:
${[...bridgeMappings.values()].map((path) => `- ${path}`).join("\n")}

Release runtime artifacts:
- pvm-gpu-worker.js

Computer prototype artifacts:
- pvm-computer.js
`;
  const sourcePath = resolve(destination, "SOURCE");
  if (checkOnly) {
    if ((await readFile(sourcePath, "utf8")) !== source) {
      throw new Error(`stale PVM runtime provenance: ${sourcePath}`);
    }
  } else {
    await writeFile(sourcePath, source);
  }
  console.log(
    `${checkOnly ? "Verified" : "Synchronized"} bridge ${lock.bridgeRevision} and computer runtime ${lock.computerRuntimeRevision}`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
