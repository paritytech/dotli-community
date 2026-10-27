// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type { Codec, ResultPayload } from 'scale-ts';
export type { CallError } from './callError.js';
export { callError, domain } from './callError.js';
export { codec } from './codec.js';
export type { RequestParams, SubscribeParams, SubscriptionListeners } from './createOutgoingCalls.js';
export { createPortProvider } from './createPortProvider.js';
export type { RequestHandler, Sink, SubscriptionHandler } from './createServedCalls.js';
export type { Transport, TransportParams } from './createTransport.js';
export { createTransport } from './createTransport.js';
export type { WindowProviderParams } from './createWindowProvider.js';
export { createWindowProvider } from './createWindowProvider.js';
export type { Address, MethodOf, Schema, Sections } from './defineSchema.js';
export { defineSchema } from './defineSchema.js';
export type { TransportIssue } from './describeIssue.js';
export { describeIssue } from './describeIssue.js';
export type { Failure } from './failure.js';
export { cancelled, denied, hostFailure, malformedFrame, unsupported } from './failure.js';
export { getFailureReason, parseReason } from './getFailureReason.js';
export type { TransportVersions } from './handshakeCodecs.js';
export type {
  AnyMethod,
  DomainError,
  MethodTypes,
  Request,
  RequestMessage,
  RequestTypes,
  Subscription,
  SubscriptionMessage,
  SubscriptionTypes,
  Variant,
} from './method.js';
export type { MessageTarget, PortLike, Provider, WindowLike, WindowMessage } from './provider.js';
export { request } from './request.js';
export { err, ok } from './result.js';
export { subscription } from './subscription.js';
export { TransportHandshakeTimeoutError } from './transportHandshakeTimeoutError.js';
export { TransportMalformedResponseError } from './transportMalformedResponseError.js';
export { TransportUnsupportedProtocolVersionError } from './transportUnsupportedProtocolVersionError.js';
export type { CallContext } from './types.js';
