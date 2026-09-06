import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, readFile, readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
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
const upstreamRuntimeInventory = [
  "polkavm-browser-runtime.wasm",
  "polkavm-worker.js",
  "polkavm-gpu-worker.js",
  "polkavm-wasm-translated.js",
  "polkavm-runtime-core.js",
  "polkavm-wasm-worker-entry.js",
  "polkavm-computer.js",
];
const synchronizedInventory = [
  "polkavm-browser-runtime.wasm",
  "polkavm-worker.js",
  "polkavm-gpu-worker.js",
  "SHA256SUMS",
  "SOURCE.json",
  "LICENSE-MPL-2.0",
];
const auxiliaryInventory = [
  "PolkaVM-LICENSE-APACHE",
  "PolkaVM-LICENSE-MIT",
];

function sorted(values) {
  return [...values].sort();
}

function requireExactInventory(actual, expected, description) {
  const actualNames = sorted(actual);
  const expectedNames = sorted(expected);
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      `${description} inventory is ${actualNames.join(", ")}, expected ${expectedNames.join(", ")}`,
    );
  }
}

function parseChecksumManifest(contents) {
  const checksums = new Map();
  for (const line of contents.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64}) {2}([^/\0]+)$/.exec(line);
    if (match === null || basename(match[2]) !== match[2]) {
      throw new Error(`invalid SHA256SUMS line: ${line}`);
    }
    if (checksums.has(match[2])) {
      throw new Error(`duplicate SHA256SUMS entry: ${match[2]}`);
    }
    checksums.set(match[2], match[1]);
  }
  requireExactInventory(
    checksums.keys(),
    upstreamRuntimeInventory,
    "upstream SHA256SUMS",
  );
  return checksums;
}

requireExactInventory(
  Object.keys(lock.assets),
  synchronizedInventory,
  "runtime lock",
);
requireExactInventory(
  await readdir(destination),
  [...synchronizedInventory, ...auxiliaryInventory],
  "vendored runtime directory",
);


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
    "SHA256SUMS",
    require.resolve(`${lock.package}/checksums`),
  );
  installedSources.set("SOURCE.json", provenancePath);
  installedSources.set("LICENSE-MPL-2.0", resolve(packageRoot, "LICENSE-MPL-2.0"));
  requireExactInventory(
    installedSources.keys(),
    synchronizedInventory,
    "installed runtime sources",
  );
}

const actualDigests = new Map();
for (const [name, expected] of Object.entries(lock.assets)) {
  const path = resolve(destination, name);
  if (!checkOnly) {
    await copyFile(installedSources.get(name), path);
  }
  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual !== expected) {
    throw new Error(`${name} has unexpected digest ${actual}`);
  }
  actualDigests.set(name, actual);
}

const upstreamChecksums = parseChecksumManifest(
  await readFile(resolve(destination, "SHA256SUMS"), "utf8"),
);
for (const name of synchronizedInventory) {
  const upstreamDigest = upstreamChecksums.get(name);
  if (upstreamDigest === undefined) {
    continue;
  }
  if (lock.assets[name] !== upstreamDigest) {
    throw new Error(
      `${name} lock digest does not match upstream SHA256SUMS`,
    );
  }
  if (actualDigests.get(name) !== upstreamDigest) {
    throw new Error(`${name} does not match upstream SHA256SUMS`);
  }
}

const source = JSON.parse(
  await readFile(resolve(destination, "SOURCE.json"), "utf8"),
);
if (
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
