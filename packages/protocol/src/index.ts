// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/protocol. Other workspace packages import only from here;
// every other module under src/ is private to the package.

export {
  SHARED_CORE_SESSION_KEY,
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isSharedModeRequestMethod,
  isValidSharedAuthKey,
  isValidSharedModeKey,
} from "./auth-storage.js";
export {
  createChainBrokerManager,
  requireBrokerLocalProvider,
  type ChainBrokerManager,
  type StringJsonRpcConnection,
} from "./broker.js";
export {
  clearSharedAuthStorage,
  clearSharedModeStorage,
  createRemoteChainProvider,
  ensureProtocolFrame,
  getProtocolOrigin,
  getSmoldotDbOutcome,
  isRemoteChainConnectable,
  isRemoteChainSupported,
  onProtocolChainDetail,
  onProtocolChainSync,
  onProtocolNetBytes,
  readSharedAuthStorage,
  readSharedModeStorage,
  resetProtocolFrame,
  resolveDotNameRemote,
  resolveExecutableManifestRemote,
  resolveRootManifestRemote,
  setProtocolSubMode,
  subscribeSharedAuthStorage,
  warmupProtocol,
  writeSharedAuthStorage,
  writeSharedModeStorage,
} from "./client.js";
export { ProtocolFatalError, ProtocolInitFailedError } from "./errors.js";
export {
  getRequestSyncTimeoutMs,
  isProtocolEnvelope,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
  type SmoldotDbChain,
  type SmoldotDbOutcome,
} from "./messages.js";
export { METHOD_TIMEOUTS } from "./method-timeouts.js";
