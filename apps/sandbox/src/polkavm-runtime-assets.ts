// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import runtimeLock from "../../../scripts/polkavm-runtime.lock.json";

export const POLKAVM_RUNTIME_SOURCE = `parity-polkavm-browser-runtime-${runtimeLock.packageVersion}-${runtimeLock.upstreamRevision}`;

export function polkaVmRuntimeAssetUrl(
  asset: keyof typeof runtimeLock.assets,
): string {
  // Unversioned force-cache requests can pair an old Wasm with a new worker.
  return `/polkavm-runtime/${asset}?v=${runtimeLock.assets[asset]}`;
}
