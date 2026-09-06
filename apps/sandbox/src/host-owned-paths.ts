// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Archive paths reserved for the sandbox's host-owned PolkaVM runtime.
 *
 * The legacy root worker name remains reserved after moving the supervisor
 * under `polkavm-runtime/`: an older page or service worker must never be able
 * to fetch an archive-provided supervisor while an update is in flight.
 */
const LEGACY_COMPUTER_WORKER_PATH = "polkavm-computer-worker.js";
const POLKAVM_RUNTIME_PATH_PREFIX = "polkavm-runtime/";

export function shadowsHostOwnedPath(path: string): boolean {
  const relative = path.startsWith("/") ? path.slice(1) : path;
  return (
    relative === LEGACY_COMPUTER_WORKER_PATH ||
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
