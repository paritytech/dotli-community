// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const POLKAVM_RUNTIME_ROOT = "/polkavm-runtime";

const configuredRuntimeVersion = (
  import.meta.env.VITE_COMMIT_SHA as string | undefined
)?.trim();
export const POLKAVM_RUNTIME_VERSION =
  configuredRuntimeVersion === undefined || configuredRuntimeVersion === ""
    ? "dev"
    : configuredRuntimeVersion;

/**
 * Public runtime assets keep stable filenames, so every deployment must use a
 * release-specific URL. Otherwise `force-cache` can pair a new worker with an
 * older Wasm ABI from the browser HTTP cache.
 */
export function polkaVmRuntimeAssetUrl(fileName: string): string {
  return `${POLKAVM_RUNTIME_ROOT}/${fileName}?v=${encodeURIComponent(POLKAVM_RUNTIME_VERSION)}`;
}
