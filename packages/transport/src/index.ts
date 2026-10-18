// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export { codec, none } from './codec.js';
export type { Codec } from './codec.js';
export { TransportHandshakeTimeoutError, TransportVersionMismatchError } from './errors.js';
export type { TransportIssue } from './errors.js';
export { createPortProvider, createWindowProvider } from './provider.js';
export type { MessageTarget, PortLike, Provider, WindowLike, WindowProviderDeps } from './provider.js';
export { cancelled, denied, domain, err, hostFailure, malformedFrame, ok, unsupported } from './result.js';
export type { CallError, Result } from './result.js';
export { defineSchema, request, subscription } from './schema.js';
export type {
  DomainError,
  HelloOf,
  MethodName,
  MethodTypes,
  RequestDef,
  RequestMethodName,
  Schema,
  SubscriptionDef,
  SubscriptionMethodName,
  TraitName,
  Traits,
} from './schema.js';
export type { CallContext } from './serving.js';
export { createTransport } from './transport.js';
export type { RequestHandler, RequestOptions, Transport, TransportOptions } from './transport.js';
