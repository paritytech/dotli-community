// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/resolver. Other workspace packages import only from here.
// Every other module under src/ is private to the package.

export { type ResolvePhase } from './access-raw-storage.js';
export { chainBytesReceived, installByteMeter } from './byte-meter.js';
export { type ChainKey, type ChainPeer, type ChainSyncKind } from './chain-sync.js';
export { type ResolverErrorName } from './errors.js';
// Keep cached-manifest validation free of the chain-storage reader.
export {
  parseExecutableManifest,
  parseRootManifest,
  toExecutableManifestResult,
  toRootManifestResult,
  validateExecutableManifest,
  validateRootManifest,
  type AppManifest,
  type AppManifestV1,
  type AppManifestV2,
  type AppVersion,
  type ExecutableKind,
  type ExecutableManifest,
  type FileInputHandler,
  type FileInputRequirement,
  type ManifestRecordResult,
  type ManifestResult,
  type PolkaVmAppManifestV2,
  type RootManifest,
  type WebAppManifestV2,
  type WidgetManifest,
  type WorkerManifest,
  type ValidationResult,
} from './manifest-types.js';
export { createChainProvider, isChainSupported, onProviderFatal, onSmoldotDbOutcome } from './provider.js';
export {
  resolveDotName,
  resolveExecutableManifest,
  resolveOwner,
  resolveRootManifest,
  resolveSeitySlot,
  setResolverAssetHubProvider,
  setResolverPeopleProvider,
  waitForAssetHubFinalized,
  waitForPeopleFinalized,
  type ResolveOptions,
} from './resolve.js';
export { type SeitySlot } from './seity-registry.js';
export { createCoreRpcChainProvider, getConnectedRpcEndpoint, isCoreRpcChainSupported } from './rpc-chain.js';
export { type ChainTransportHooks, type ConnectionStatus } from './transport-hooks.js';
export {
  loadProvider,
  loadResolve,
  loadRpcResolve,
  type ProviderModule,
  type ResolveModule,
  type RpcResolveModule,
} from './lazy.js';
