// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Enum, Result, _void, type Codec } from 'scale-ts';
import { callError } from './callError.js';
import { createMethod, type Request } from './method.js';

// A leg's payload is read as nothing, so reading a message's leg reads only its tag and copies no payload.
const requestLeg = createRequestLegs(_void, _void).dec;

/** Declares a request. `error` is the method's own error, and a method without one has an empty one. */
export function request<Payload, Response>(definition: {
  request: Codec<Payload>;
  response: Codec<Response>;
}): Request<Payload, Response, undefined>;
export function request<Payload, Response, Domain>(definition: {
  request: Codec<Payload>;
  response: Codec<Response>;
  error: Codec<Domain>;
}): Request<Payload, Response, Domain>;
export function request<Payload, Response, Domain>(definition: {
  request: Codec<Payload>;
  response: Codec<Response>;
  error?: Codec<Domain>;
}): Request<Payload, Response, Domain> | Request<Payload, Response, undefined> {
  return definition.error === undefined
    ? createRequest(definition, _void)
    : createRequest(definition, definition.error);
}

/** The request of `definition` whose own error is `error`. */
function createRequest<Payload, Response, Domain>(
  definition: { request: Codec<Payload>; response: Codec<Response> },
  error: Codec<Domain>,
): Request<Payload, Response, Domain> {
  return createMethod(createRequestLegs(definition.request, Result(definition.response, callError(error))), requestLeg);
}

// A request's legs in wire order, so its message and the reader of its leg share one layout.
function createRequestLegs<Payload, Answer>(request: Codec<Payload>, response: Codec<Answer>) {
  return Enum({ request, response });
}
