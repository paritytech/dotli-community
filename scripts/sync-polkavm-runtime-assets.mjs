import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
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

// The UserAgentKit distribution ships artifacts under the exact `polkavm-`
// paths this Host serves. Every file is verified against the package checksum
// manifest before it is copied; the checksum manifest itself is preserved
// byte-for-byte.
// Package export subpath every servable artifact is resolved through. Which of
// them this host actually serves is the lockfile's decision.
const runtimeExports = new Map([
  ["polkavm-browser-runtime.wasm", "runtime.wasm"],
  ["polkavm-worker.js", "worker"],
  ["polkavm-gpu-worker.js", "gpu-worker"],
  ["polkavm-computer.js", "computer"],
]);
// Artifacts the package manifest covers. The translated backend, the runtime
// core, and the worker entry are embedded inside `polkavm-worker.js`, so they
// are attested but never served on their own.
const runtimeInventory = [
  "polkavm-browser-runtime.wasm",
  "polkavm-worker.js",
  "polkavm-gpu-worker.js",
  "polkavm-wasm-translated.js",
  "polkavm-runtime-core.js",
  "polkavm-wasm-worker-entry.js",
  "polkavm-computer.js",
];
const generatedInventory = ["SHA256SUMS", "SOURCE.json", "LICENSE-MPL-2.0"];
const auxiliaryInventory = ["PolkaVM-LICENSE-APACHE", "PolkaVM-LICENSE-MIT"];
const synchronizedInventory = Object.keys(lock.assets);
const runtimeAssets = synchronizedInventory.filter(
  (name) =>
    !generatedInventory.includes(name) && !auxiliaryInventory.includes(name),
);
for (const name of runtimeAssets) {
  if (!runtimeExports.has(name)) {
    throw new Error(`runtime lock names an unknown artifact ${name}`);
  }
}

function sorted(values) {
  return [...values].sort();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function parseChecksumManifest(contents, expectedInventory, description) {
  const checksums = new Map();
  for (const line of contents.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64}) {2}([^/\0]+)$/.exec(line);
    if (match === null || basename(match[2]) !== match[2]) {
      throw new Error(`invalid ${description} line: ${line}`);
    }
    if (checksums.has(match[2])) {
      throw new Error(`duplicate ${description} entry: ${match[2]}`);
    }
    checksums.set(match[2], match[1]);
  }
  requireExactInventory(checksums.keys(), expectedInventory, description);
  return checksums;
}

/** The vendored provenance record, derived from the lockfile alone. */
function provenanceRecord() {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      upstreamPackage: lock.package,
      upstreamVersion: lock.packageVersion,
      upstreamRepository: lock.upstreamRepository,
      upstreamRevision: lock.upstreamRevision,
      polkavmRepository: lock.polkavmRepository,
      polkavmRevision: lock.polkavmRevision,
      abi: lock.abi,
      assetChecksums: "SHA256SUMS",
    },
    null,
    2,
  )}\n`;
}

for (const name of generatedInventory) {
  if (lock.assets[name] === undefined) {
    throw new Error(`runtime lock is missing ${name}`);
  }
}
if (runtimeAssets.length === 0) {
  throw new Error("runtime lock names no runtime artifacts");
}
requireExactInventory(
  await readdir(destination),
  synchronizedInventory,
  "vendored runtime directory",
);

if (!checkOnly) {
  let checksumsPath;
  try {
    checksumsPath = require.resolve(`${lock.package}/checksums`);
  } catch {
    throw new Error(
      `${lock.package} is not installed; install the ${lock.packageVersion} release tarball before synchronizing runtime assets`,
    );
  }
  const installedVersion = JSON.parse(
    await readFile(
      resolve(dirname(dirname(checksumsPath)), "package.json"),
      "utf8",
    ),
  ).version;
  if (installedVersion !== lock.packageVersion) {
    throw new Error(
      `${lock.package} ${installedVersion} is installed, expected ${lock.packageVersion}`,
    );
  }
  const packageChecksums = parseChecksumManifest(
    await readFile(checksumsPath, "utf8"),
    runtimeInventory,
    "package SHA256SUMS",
  );
  for (const name of runtimeAssets) {
    const path = resolve(destination, name);
    await copyFile(
      require.resolve(`${lock.package}/${runtimeExports.get(name)}`),
      path,
    );
    const digest = sha256(await readFile(path));
    if (digest !== packageChecksums.get(name)) {
      throw new Error(`${name} does not match the package SHA256SUMS`);
    }
  }
  await copyFile(
    resolve(dirname(dirname(checksumsPath)), "LICENSE-MPL-2.0"),
    resolve(destination, "LICENSE-MPL-2.0"),
  );
  await copyFile(checksumsPath, resolve(destination, "SHA256SUMS"));
  await writeFile(resolve(destination, "SOURCE.json"), provenanceRecord());
}

const actualDigests = new Map();
for (const [name, expected] of Object.entries(lock.assets)) {
  const actual = sha256(await readFile(resolve(destination, name)));
  if (actual !== expected) {
    throw new Error(`${name} has unexpected digest ${actual}`);
  }
  actualDigests.set(name, actual);
}

// The package manifest attests every runtime artifact, including the three the
// worker embeds rather than fetches.
const vendoredChecksums = parseChecksumManifest(
  await readFile(resolve(destination, "SHA256SUMS"), "utf8"),
  runtimeInventory,
  "vendored SHA256SUMS",
);
for (const name of runtimeAssets) {
  if (vendoredChecksums.get(name) !== actualDigests.get(name)) {
    throw new Error(`${name} does not match the vendored SHA256SUMS`);
  }
  if (lock.assets[name] !== vendoredChecksums.get(name)) {
    throw new Error(
      `${name} lock digest does not match the vendored SHA256SUMS`,
    );
  }
}

const provenance = await readFile(resolve(destination, "SOURCE.json"), "utf8");
if (provenance !== provenanceRecord()) {
  throw new Error("PolkaVM runtime provenance does not match the lockfile");
}

const runtimeSource = await readFile(
  resolve(root, "apps/sandbox/src/polkavm-runtime.ts"),
  "utf8",
);
const declaredRuntimeSource =
  /const RUNTIME_SOURCE\s*=\s*"([^"]+)";/.exec(runtimeSource)?.[1] ?? null;
const expectedRuntimeSource = `${lock.package
  .replace(/^@/, "")
  .replaceAll("/", "-")}-${lock.packageVersion}-${lock.upstreamRevision}`;
if (declaredRuntimeSource !== expectedRuntimeSource) {
  throw new Error(
    `runtime cache identity is ${String(declaredRuntimeSource)}, expected ${expectedRuntimeSource}`,
  );
}

console.log(
  `${checkOnly ? "Verified" : "Synchronized"} ${lock.package} ${lock.packageVersion} assets from upstream revision ${lock.upstreamRevision}`,
);
