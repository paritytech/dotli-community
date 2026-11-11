// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Enum, Result, _void, createCodec, createDecoder, u8, type Codec, type ResultPayload } from 'scale-ts';
import { callError } from './callError.js';
import { createMethod, type Request } from './method.js';

// A leg's payload is read as nothing, so reading a message's leg reads only its tag and copies no payload.
const requestLeg = createRequestLegs(_void, _void).dec;

/**
 * Declares a request. `error` is the method's own error, and a method without one has an empty one.
 *
 * @example
 * const getAccount = request({ request: str, response: u32, error: str });
 */
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
  return createMethod(
    createRequestLegs(definition.request, createAnswerCodec(definition.response, callError(error))),
    requestLeg,
  );
}

// A request's legs in wire order, so its message and the reader of its leg share one layout.
function createRequestLegs<Payload, Answer>(request: Codec<Payload>, response: Codec<Answer>) {
  return Enum({ request, response });
}

/** A request's answer, which refuses an outcome tag above 1 where scale-ts's `Result` reads it as a failure. */
function createAnswerCodec<Response, Failure>(
  response: Codec<Response>,
  failure: Codec<Failure>,
): Codec<ResultPayload<Response, Failure>> {
  const decode = createDecoder((bytes): ResultPayload<Response, Failure> => {
    const outcome = u8.dec(bytes);
    if (outcome > 1) {
      throw new RangeError(`Unknown outcome tag ${String(outcome)} in a request's answer`);
    }
    return outcome === 0
      ? { success: true, value: response.dec(bytes) }
      : { success: false, value: failure.dec(bytes) };
  });
  return createCodec(Result.enc(response.enc, failure.enc), decode);
}
