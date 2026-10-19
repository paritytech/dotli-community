// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type { Codec, ResultPayload } from 'scale-ts';
export {
  TransportHandshakeTimeoutError,
  TransportUnsupportedProtocolVersionError,
  callError,
  cancelled,
  denied,
  describeIssue,
  domain,
  err,
  failureReason,
  hostFailure,
  malformedFrame,
  ok,
  reasonParts,
  unsupported,
} from './errors.js';
export type { CallError, Failure, TransportIssue } from './errors.js';
export { createPortProvider, createWindowProvider } from './provider.js';
export type { MessageTarget, PortLike, Provider, WindowLike, WindowMessage, WindowProviderDeps } from './provider.js';
export { codec, defineSchema, request, subscription } from './schema.js';
export type {
  Address,
  AnyMethod,
  DomainError,
  MethodOf,
  MethodTypes,
  Request,
  RequestMessage,
  RequestTypes,
  Schema,
  Subscription,
  SubscriptionMessage,
  SubscriptionTypes,
  Sections,
  Variant,
} from './schema.js';
export { createTransport } from './transport.js';
export type {
  CallContext,
  RequestHandler,
  RequestOptions,
  Sink,
  SubscribeOptions,
  SubscriptionHandler,
  SubscriptionListeners,
  Transport,
  TransportOptions,
} from './transport.js';
