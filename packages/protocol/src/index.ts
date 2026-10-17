// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export {
  SHARED_CORE_SESSION_KEY,
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isSharedModeRequestMethod,
  isSharedWalletRequestMethod,
  isValidSharedAuthKey,
  isValidSharedModeKey,
  type SharedWalletRequestMethod,
} from './auth-storage.js';
export {
  getProtocolOrigin,
  isRemoteChainConnectable,
  isRemoteChainSupported,
  protocolClient,
  type ProtocolClient,
  type ProtocolFrameConfig,
  type ProtocolStatus,
  type LocalWalletReadResult,
  type RemoteChainProvider,
  type SharedStoreStatus,
} from './client.js';
export { backendOfFrameMode } from './frame.js';
export {
  ProtocolFatalError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolVersionMismatchError,
} from './errors.js';
export type {
  Answer,
  LocalWalletIdentity,
  RequestMethod,
  RequestPayload,
  SubscribePayload,
  SubscriptionEvent,
  SubscriptionMethod,
  TelemetryEvent,
} from './methods.js';
export { createPortProvider, createWindowProvider } from './provider.js';
export { createConsumerTransport, type ConsumerTransport } from './transport-consumer.js';
export {
  createServingTransport,
  type CallContext,
  type RequestHandler,
  type ServingTransport,
  type SubscriptionHandler,
  type SubscriptionSink,
} from './transport-serving.js';
