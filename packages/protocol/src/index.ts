// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export {
  SHARED_AUTH_KEY_PREFIX,
  SHARED_CORE_SESSION_KEY,
  buildSharedAuthStorageKey,
  isSharedAuthSiteId,
  isValidSharedAuthKey,
} from './sharedAuthKeys.js';
export {
  SHARED_MODE_KEY_PREFIX,
  buildSharedModeStorageKey,
  isSharedModeRequestMethod,
  isValidSharedModeKey,
} from './sharedModeKeys.js';
export { isSharedAuthOriginAllowed } from './isSharedAuthOriginAllowed.js';
export { getProtocolOrigin } from './getProtocolOrigin.js';
export type { ProtocolClient } from './createProtocolClient.js';
export { getProtocolClient } from './createProtocolClient.js';
export type { ProtocolFrameConfig, ProtocolStatus } from './frameTypes.js';
export { isFrameDown } from './frameTypes.js';
export { getBackendOfFrameMode } from './getBackendOfFrameMode.js';
export { isRemoteChainConnectable } from './isRemoteChainConnectable.js';
export { isRemoteChainSupported } from './isRemoteChainSupported.js';
export type { RemoteChainProvider } from './createRemoteChains.js';
export type { LocalWalletReadResult, SharedStoreStatus } from './createSharedStore.js';
export {
  ProtocolFatalError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolVersionMismatchError,
  fromTransportError,
  getFailure,
  toFrameStatusEnd,
  toRemoteEnd,
} from './errors.js';
export type { TelemetryEvent } from './codecValues.js';
export type {
  DomainFailure,
  FrameFailure,
  LocalWalletIdentity,
  LocalWalletRead,
  ProtocolContext,
  ProtocolHandler,
  ProtocolHello,
  ProtocolSchema,
  ProtocolServing,
  ProtocolTransport,
  RemoteFailure,
  SharedAuthChange,
  SubscriptionEnd,
} from './schema.js';
export { isLocalWalletEntropy, isLocalWalletIdentity, protocolSchema } from './schema.js';
export type { CallName, MethodPolicy } from './methodPolicy.js';
export { getBudget, getCallName, getPolicy } from './methodPolicy.js';
export type { FrameStatus, FrameStatusEnd, FrameStatusSink } from './createFrameStatus.js';
export { createFrameStatus } from './createFrameStatus.js';
export { createEndListeners } from './createEndListeners.js';
export { createWireReport } from './createWireReport.js';
