// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/resolver. Other workspace packages import only from here;
// every other module under src/ is private to the package.

export { type ResolvePhase } from "./access-raw-storage.js";
export { chainBytesReceived, installByteMeter } from "./byte-meter.js";
export {
  type ChainKey,
  type ChainPeer,
  type ChainSyncKind,
} from "./chain-sync.js";
export { type ResolverErrorName } from "./errors.js";
export {
  type ExecutableManifest,
  type ManifestResult,
  type RootManifest,
} from "./manifest.js";
export {
  createChainProvider,
  isChainSupported,
  onProviderFatal,
  onSmoldotDbOutcome,
} from "./provider.js";
export {
  resolveDotName,
  resolveExecutableManifest,
  resolveOwner,
  resolveRootManifest,
  setResolverAssetHubProvider,
  setResolverPeopleProvider,
  waitForAssetHubFinalized,
  waitForPeopleFinalized,
  type ResolveOptions,
} from "./resolve.js";
export {
  createCoreRpcChainProvider,
  isCoreRpcChainSupported,
  isRpcChainSupported,
} from "./rpc-chain.js";

// Lazy entry points. Each module is its own chunk, fetched on first call;
// a static re-export here would pull it into every importer's bundle.
export type ProviderModule = typeof import("./provider.js");
export const loadProvider = (): Promise<ProviderModule> =>
  import("./provider.js");
export type ResolveModule = typeof import("./resolve.js");
export const loadResolve = (): Promise<ResolveModule> => import("./resolve.js");
export type RpcResolveModule = typeof import("./rpc-resolve.js");
export const loadRpcResolve = (): Promise<RpcResolveModule> =>
  import("./rpc-resolve.js");
