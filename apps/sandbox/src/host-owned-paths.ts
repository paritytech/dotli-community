// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Archive paths reserved for the sandbox's host-owned PolkaVM runtime.
 *
 * Archive entries cannot shadow any file below the host-owned runtime tree.
 * The computer worker is bundled into the sandbox application rather than
 * exposed at a stable package-shadowable URL.
 */
const POLKAVM_RUNTIME_PATH_PREFIX = "polkavm-runtime/";

export function shadowsHostOwnedPath(path: string): boolean {
  const relative = path.startsWith("/") ? path.slice(1) : path;
  return (
    relative === POLKAVM_RUNTIME_PATH_PREFIX.slice(0, -1) ||
    relative.startsWith(POLKAVM_RUNTIME_PATH_PREFIX)
  );
}

export function assertNoHostOwnedPaths(paths: Iterable<string>): void {
  for (const path of paths) {
    if (shadowsHostOwnedPath(path)) {
      throw new Error(`archive path is reserved by the host: ${path}`);
    }
  }
}
