// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Archive paths reserved for the sandbox's host-owned PolkaVM runtime.
 *
 * Archive entries cannot shadow any file below the host-owned runtime tree.
 */
const POLKAVM_RUNTIME_PATH_PREFIX = "polkavm-runtime/";

function isHostOwnedPath(path: string): boolean {
  return (
    path === POLKAVM_RUNTIME_PATH_PREFIX.slice(0, -1) ||
    path.startsWith(POLKAVM_RUNTIME_PATH_PREFIX)
  );
}

export function shadowsHostOwnedPath(path: string): boolean {
  const relative = path.startsWith("/") ? path.slice(1) : path;
  if (isHostOwnedPath(relative)) {
    return true;
  }
  try {
    return isHostOwnedPath(decodeURIComponent(relative));
  } catch {
    return false;
  }
}

export function assertNoHostOwnedPaths(paths: Iterable<string>): void {
  for (const path of paths) {
    if (shadowsHostOwnedPath(path)) {
      throw new Error(`archive path is reserved by the host: ${path}`);
    }
  }
}
