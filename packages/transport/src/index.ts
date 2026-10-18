// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type { SubscriptionHandle, SubscriptionListeners } from './calls.js';
export { codec } from './codec.js';
export type { Codec } from './codec.js';
export { TransportHandshakeTimeoutError, TransportVersionMismatchError } from './errors.js';
export type { TransportIssue } from './errors.js';
export { createPortProvider, createWindowProvider } from './provider.js';
export type { MessageTarget, PortLike, Provider, WindowLike, WindowProviderDeps } from './provider.js';
export { cancelled, denied, domain, err, hostFailure, malformedFrame, ok, unsupported } from './result.js';
export type { CallError, Result, Variant } from './result.js';
export { defineSchema, request, subscription } from './schema.js';
export type {
  Address,
  AnyMethod,
  DomainError,
  MethodTypes,
  Request,
  RequestMessage,
  RequestTypes,
  Schema,
  Subscription,
  SubscriptionMessage,
  SubscriptionTypes,
  Traits,
} from './schema.js';
export type { CallContext, RequestHandler, Sink, SubscriptionHandler } from './serving.js';
export { createTransport } from './transport.js';
export type { RequestOptions, SubscribeOptions, Transport, TransportOptions } from './transport.js';
