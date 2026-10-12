#!/usr/bin/env bash
# Rebuilds vendor/truapi and vendor/truapi-host from a trinity-user-agents (host-rust-core) revision with upstream's
# standard release steps, then rewrites vendor/truapi-host.lock.json to match.
#
#   scripts/build-vendored-truapi-host.sh [--repo URL|PATH] [--revision SHA] [--branch NAME] [--pr NUMBER]
#                                         [--cache DIR]
#
# --repo      Git URL or local checkout holding the revision. Defaults to the lock's upstreamRepository. A URL is
#             recorded in the lock; a local checkout only supplies the objects and the recorded URL is kept.
# --revision  Commit to build. Defaults to the lock's upstreamRevision. Recorded as upstreamRevision and
#             wasmUpstreamRevision.
# --branch    Recorded as upstreamBranch. Defaults to the recorded value.
# --pr        Upstream pull request number, recorded as pullRequest. Defaults to the recorded value.
# --cache     Build cache root. Defaults to ${XDG_CACHE_HOME:-~/.cache}/dotli-truapi-host. The revision is exported to
#             <cache>/<revision>; its Cargo outputs stay in <cache>/<revision>/target between runs.
#
# The source is a `git archive` export, so the build sees exactly the committed tree. wasm-bindgen must match the
# revision's Cargo.lock and wasm-opt the Binaryen release its scripts/install-wasm-artifact-tools.sh pins; the script
# fails if neither PATH nor the usual install locations provide those versions.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock="$root/vendor/truapi-host.lock.json"
override_name='@parity/truapi'
override_spec='file:../truapi'

die() {
  printf 'build-vendored-truapi-host: %s\n' "$*" >&2
  exit 1
}

repo=''
revision=''
branch=''
pr=''
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/dotli-truapi-host"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo | --revision | --branch | --pr | --cache)
      [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"
      case "$1" in
        --repo) repo="$2" ;;
        --revision) revision="$2" ;;
        --branch) branch="$2" ;;
        --pr) pr="$2" ;;
        --cache) cache_root="$2" ;;
      esac
      shift 2
      ;;
    -h | --help)
      sed -n '2,/^set -euo pipefail$/{/^#/s/^# \{0,1\}//p}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

for tool in git node npm tar sha256sum cargo wasm-pack; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done
[[ -f "$lock" ]] || die "missing $lock"

read_lock() {
  node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (typeof v === "string") process.stdout.write(v);' "$lock" "$1"
}
recorded_repository="$(read_lock upstreamRepository)"
[[ -n "$repo" ]] || repo="$recorded_repository"
[[ -n "$repo" ]] || die "no --repo given and the lock records no upstreamRepository"
[[ -n "$revision" ]] || revision="$(read_lock upstreamRevision)"
[[ -n "$revision" ]] || die "no --revision given and the lock records no upstreamRevision"
[[ -z "$pr" || "$pr" =~ ^[1-9][0-9]*$ ]] || die "--pr must be a pull request number, got: $pr"

# Resolve the revision into a git directory that holds it.
if [[ -d "$repo" ]]; then
  git_dir="$(git -C "$repo" rev-parse --absolute-git-dir)"
  recorded_url="$recorded_repository"
else
  git_dir="$cache_root/objects.git"
  [[ -d "$git_dir" ]] || git init --quiet --bare "$git_dir"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "a remote --repo needs a full 40-character commit id, got: $revision"
  if ! git --git-dir="$git_dir" cat-file -e "$revision^{commit}" 2>/dev/null; then
    git --git-dir="$git_dir" fetch --quiet --depth=1 "$repo" "$revision"
  fi
  recorded_url="${repo%.git}"
fi
revision="$(git --git-dir="$git_dir" rev-parse --verify --quiet "$revision^{commit}")" ||
  die "$repo does not contain commit $revision"
[[ -n "$recorded_url" ]] || die "the lock records no upstreamRepository; pass --repo with the repository URL"

cache="$cache_root/$revision"
src="$cache"
target="$cache/target"
packs="$cache/packs"
mkdir -p "$cache"
# A fresh export each run; only Cargo's outputs are reused.
find "$cache" -mindepth 1 -maxdepth 1 ! -name target -exec rm -rf {} +
git --git-dir="$git_dir" archive --format=tar "$revision" | tar -x -C "$src"
printf 'Exported %s@%s to %s\n' "$recorded_url" "$revision" "$src"

# Tool versions come from the exported revision itself.
bindgen_version="$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/^version = "|"$/, ""); print; exit }' "$src/Cargo.lock")"
[[ -n "$bindgen_version" ]] || die "cannot find wasm-bindgen in $src/Cargo.lock"
binaryen_version="$(sed -n 's/^version=\([0-9][0-9]*\)$/\1/p' "$src/scripts/install-wasm-artifact-tools.sh")"
[[ -n "$binaryen_version" ]] || die "cannot find the Binaryen version in $src/scripts/install-wasm-artifact-tools.sh"

# Prints the directory of the first candidate whose `--version` output starts with $2.
locate_tool() {
  local name="$1" expected="$2" candidate
  shift 2
  for candidate in "$(command -v "$name" || true)" "$@"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    if [[ "$("$candidate" --version 2>/dev/null)" == "$expected"* ]]; then
      dirname "$candidate"
      return 0
    fi
  done
  return 1
}
bindgen_dir="$(locate_tool wasm-bindgen "wasm-bindgen $bindgen_version" \
  "$HOME/.cargo/bin/wasm-bindgen" "$cache_root/tools/wasm-bindgen-$bindgen_version/bin/wasm-bindgen")" ||
  die "wasm-bindgen $bindgen_version not found; install it with:
  cargo install wasm-bindgen-cli --version $bindgen_version --locked --root $cache_root/tools/wasm-bindgen-$bindgen_version"
binaryen_dir="$(locate_tool wasm-opt "wasm-opt version $binaryen_version " \
  "$HOME/.local/share/truapi-wasm-tools/binaryen-version_$binaryen_version/bin/wasm-opt")" ||
  die "wasm-opt (Binaryen $binaryen_version) not found; install it with:
  bash $src/scripts/install-wasm-artifact-tools.sh"
export PATH="$bindgen_dir:$binaryen_dir:$PATH"
# sccache keys ignore the environment the build reads; an explicit target directory replaces it.
export RUSTC_WRAPPER=
unset TRUAPI_WASM_PROFILE
printf 'Tools: %s, %s, %s, node %s, npm %s\n' "$(wasm-bindgen --version)" "$(wasm-opt --version)" \
  "$(wasm-pack --version)" "$(node --version)" "$(npm --version)"

# Cargo steps run under dev-maintenance when installed, which tracks and locks the target directory.
dev_maintenance="$HOME/.local/bin/dev-maintenance"
cargo_step() {
  if [[ -x "$dev_maintenance" ]]; then
    "$dev_maintenance" run --target "$target" -- "$@"
  else
    CARGO_TARGET_DIR="$target" "$@"
  fi
}

wasm_log="$cache/build-wasm.log"
(
  cd "$src"
  npm ci --ignore-scripts
  cargo_step ./scripts/codegen.sh
  npm run build --prefix js/packages/truapi
  npm run build --prefix js/packages/truapi-host
  cargo_step npm run build:wasm --prefix js/packages/truapi-host 2>&1 | tee "$wasm_log"
  mkdir -p "$packs"
  (cd js/packages/truapi && npm pack --pack-destination "$packs")
  (cd js/packages/truapi-host && npm pack --pack-destination "$packs")
)

truapi_pack="$(find "$packs" -maxdepth 1 -name 'parity-truapi-[0-9]*.tgz' -print -quit)"
host_pack="$(find "$packs" -maxdepth 1 -name 'parity-truapi-host-[0-9]*.tgz' -print -quit)"
[[ -f "$truapi_pack" && -f "$host_pack" ]] || die "npm pack did not produce both archives in $packs"

# Replace each package's contents with its archive. node_modules is the dotli install, not package content.
install_pack() {
  local pack="$1" dir="$root/vendor/$2"
  mkdir -p "$dir"
  find "$dir" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  tar -xzf "$pack" -C "$dir" --strip-components=1 package/
}
install_pack "$truapi_pack" truapi
install_pack "$host_pack" truapi-host

# Records the archives as packed; the vendored host then resolves @parity/truapi from its vendored sibling.
LOCK="$lock" ROOT="$root" REVISION="$revision" REPOSITORY="$recorded_url" BRANCH="$branch" PR="$pr" \
  TRUAPI_PACK="$truapi_pack" HOST_PACK="$host_pack" WASM_LOG="$wasm_log" \
  OVERRIDE_NAME="$override_name" OVERRIDE_SPEC="$override_spec" node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const fail = (message) => {
  console.error(`build-vendored-truapi-host: ${message}`);
  process.exit(1);
};
const truapiDir = join(env.ROOT, "vendor/truapi");
const hostDir = join(env.ROOT, "vendor/truapi-host");

const hostManifestPath = join(hostDir, "package.json");
const hostManifestText = readFileSync(hostManifestPath, "utf8");
const packedSpec = JSON.parse(hostManifestText).dependencies?.[env.OVERRIDE_NAME];
if (packedSpec === undefined) fail(`vendor/truapi-host does not depend on ${env.OVERRIDE_NAME}`);
const packedEntry = `${JSON.stringify(env.OVERRIDE_NAME)}: ${JSON.stringify(packedSpec)}`;
if (hostManifestText.split(packedEntry).length !== 2) fail(`expected exactly one ${packedEntry} in vendor/truapi-host`);
writeFileSync(
  hostManifestPath,
  hostManifestText.replace(packedEntry, `${JSON.stringify(env.OVERRIDE_NAME)}: ${JSON.stringify(env.OVERRIDE_SPEC)}`),
);

// build-wasm.mjs announces each bundle as "... truapi --target web --release[ --features a,b] → <dir>/<bundle>".
const features = {};
for (const line of readFileSync(env.WASM_LOG, "utf8").split("\n")) {
  const match = /^cargo rustc \+ wasm-bindgen \+ wasm-opt truapi --target web --release(?: --features (\S+))? → .*\/dist\/wasm\/(\w+)$/.exec(line);
  if (match) features[match[2]] = match[1] ? match[1].split(",") : [];
}
const wasm = {};
for (const bundle of ["web", "testing"]) {
  if (!features[bundle]) fail(`build:wasm did not report the ${bundle} bundle (see ${env.WASM_LOG})`);
  wasm[bundle] = {
    sha256: sha256(join(hostDir, "dist/wasm", bundle, "truapi_server_bg.wasm")),
    features: features[bundle],
  };
}

const lockText = readFileSync(env.LOCK, "utf8");
const lock = JSON.parse(lockText);
lock.upstreamRepository = env.REPOSITORY;
if (env.BRANCH) lock.upstreamBranch = env.BRANCH;
lock.upstreamRevision = env.REVISION;
lock.packages ??= {};
const truapiManifest = JSON.parse(readFileSync(join(truapiDir, "package.json"), "utf8"));
lock.packages["vendor/truapi"] = Object.assign(lock.packages["vendor/truapi"] ?? {}, {
  name: truapiManifest.name,
  version: truapiManifest.version,
  sourceArchiveSha256: sha256(env.TRUAPI_PACK),
  clientSha256: sha256(join(truapiDir, "dist/generated/client.js")),
});
const hostManifest = JSON.parse(readFileSync(hostManifestPath, "utf8"));
lock.packages["vendor/truapi-host"] = Object.assign(lock.packages["vendor/truapi-host"] ?? {}, {
  name: hostManifest.name,
  version: hostManifest.version,
  sourceArchiveSha256: sha256(env.HOST_PACK),
  dependencyOverride: `${env.OVERRIDE_NAME}=${env.OVERRIDE_SPEC}`,
  wasm,
});
lock.wasmUpstreamRevision = env.REVISION;
if (env.PR) lock.pullRequest = `${env.REPOSITORY}/pull/${env.PR}`;

// Two-space JSON; string arrays stay on one line unless the existing lock already spreads arrays over lines.
let text = JSON.stringify(lock, null, 2);
if (!/\[\n/.test(lockText)) {
  text = text.replace(
    /\[\n\s+("[^"\n]*"(?:,\n\s+"[^"\n]*")*)\n\s+\]/g,
    (_, items) => `[${items.split(/,\n\s+/).join(", ")}]`,
  );
}
writeFileSync(env.LOCK, `${text}\n`);
'

printf 'Vendored %s and %s from %s\n' "$(basename "$truapi_pack")" "$(basename "$host_pack")" "$revision"
printf 'Run `npx npm@12.2.0 install --allow-remote=root` if their dependencies changed, then review `git diff vendor`.\n'
