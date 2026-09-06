import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv[2] === "--check";
if (process.argv.length > 2 && !checkOnly) {
  throw new Error("usage: sync-polkavm-runtime-assets.mjs [--check]");
}

const lock = JSON.parse(
  await readFile(resolve(root, "scripts/polkavm-runtime.lock.json"), "utf8"),
);
const destination = resolve(root, "apps/sandbox/public/polkavm-runtime");
const require = createRequire(import.meta.url);

const installedSources = new Map();
if (!checkOnly) {
  let provenancePath;
  try {
    provenancePath = require.resolve(`${lock.package}/provenance`);
  } catch {
    throw new Error(
      `${lock.package} is not installed; add its first published release before synchronizing runtime assets`,
    );
  }
  const packageRoot = dirname(provenancePath);
  installedSources.set(
    "polkavm-browser-runtime.wasm",
    require.resolve(`${lock.package}/runtime.wasm`),
  );
  installedSources.set(
    "polkavm-worker.js",
    require.resolve(`${lock.package}/worker`),
  );
  installedSources.set(
    "polkavm-gpu-worker.js",
    require.resolve(`${lock.package}/gpu-worker`),
  );
  installedSources.set(
    "polkavm-computer.js",
    require.resolve(`${lock.package}/computer`),
  );
  installedSources.set(
    "SHA256SUMS",
    require.resolve(`${lock.package}/checksums`),
  );
  installedSources.set("SOURCE.json", provenancePath);
  installedSources.set("LICENSE-MPL-2.0", resolve(packageRoot, "LICENSE-MPL-2.0"));
}

for (const [name, expected] of Object.entries(lock.assets)) {
  const path = resolve(destination, name);
  if (!checkOnly) {
    await copyFile(installedSources.get(name), path);
    if (name === "SOURCE.json") {
      const provenance = JSON.parse(await readFile(path, "utf8"));
      await writeFile(
        path,
        `${JSON.stringify(
          { ...provenance, sourceRevision: lock.sourceRevision },
          null,
          2,
        )}\n`,
      );
    }
  }
  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual !== expected) {
    throw new Error(`${name} has unexpected digest ${actual}`);
  }
}

const source = JSON.parse(
  await readFile(resolve(destination, "SOURCE.json"), "utf8"),
);
if (
  source.sourceRevision !== lock.sourceRevision ||
  source.upstreamRevision !== lock.upstreamRevision ||
  source.polkavmRevision !== lock.polkavmRevision ||
  source.abi?.runtime !== lock.abi.runtime ||
  source.abi?.graphics !== lock.abi.graphics ||
  source.abi?.input !== lock.abi.input ||
  source.abi?.audio !== lock.abi.audio ||
  source.abi?.computer?.major !== lock.abi.computer.major ||
  source.abi?.computer?.minor !== lock.abi.computer.minor
) {
  throw new Error("PolkaVM runtime provenance does not match the lockfile");
}

console.log(
  `${checkOnly ? "Verified" : "Synchronized"} ${lock.package} assets from source revision ${lock.sourceRevision}`,
);
