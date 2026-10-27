// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { setErrorName, withTimeout } from '@dotli/shared';
import { concatBytes } from '@noble/hashes/utils.js';

import { CONTENT_ERRORS } from './errors.js';
import { getGatewayHost } from './getGatewayHost.js';

export type GatewayLimits = {
  /** How long the gateway may send nothing, before its headers or between two parts of its body. */
  stallMs: number;
  /** The most bytes one response may carry, since it is held whole in memory. */
  maxBytes: number;
};

type Params = {
  /** The full URL to request. */
  url: string;
  /** The Accept header value to send. */
  accept: string;
  /** The CID being read, named in failure messages. */
  cid: string;
  /** The gateway's base URL, whose host is named in failure messages. */
  gateway: string;
  /** How a non-ok status is described. */
  failure: string;
  /** The network the request goes through. */
  fetch: typeof fetch;
  /** The stall and size limits. The defaults when not given. */
  limits?: GatewayLimits | undefined;
};

/** A stalled gateway must end in a failure the visitor can retry, not a load that waits forever. */
const GATEWAY_LIMITS: GatewayLimits = { stallMs: 30_000, maxBytes: 256 * 1024 * 1024 };

/**
 * The response body, read part by part so a stall or an oversized body ends the read. Rejects on a non-ok status, a
 * stall or a body over the byte limit.
 */
export async function readGatewayBody({
  url,
  accept,
  cid,
  gateway,
  failure,
  fetch: fetchResource,
  limits = GATEWAY_LIMITS,
}: Params): Promise<{ data: Uint8Array; contentType: string | undefined }> {
  const host = getGatewayHost(gateway);
  // Stops the transfer once this read has given up on it.
  const transfer = new AbortController();

  function createStalledError(): Error {
    const error = setErrorName(
      new Error(`IPFS gateway ${host} sent nothing for ${String(limits.stallMs)}ms for ${cid}`),
      CONTENT_ERRORS.GATEWAY_STALLED,
    );
    transfer.abort(error);
    return error;
  }

  function createTooLargeError(): Error {
    const error = setErrorName(
      new Error(`IPFS gateway ${host} sent more than ${String(limits.maxBytes)} bytes for ${cid}`),
      CONTENT_ERRORS.GATEWAY_TOO_LARGE,
    );
    transfer.abort(error);
    return error;
  }

  const response = await withTimeout({
    work: fetchResource(url, { headers: { Accept: accept }, signal: transfer.signal }),
    ms: limits.stallMs,
    timeoutError: createStalledError,
  });
  if (!response.ok) {
    const error = new Error(`${failure}: HTTP ${describeHttpStatus(response)} from ${host} for ${cid}`);
    // The error page's body is never read, so its transfer would otherwise stay open.
    transfer.abort(error);
    throw error;
  }
  const contentType = response.headers.get('content-type') ?? undefined;
  if (Number(response.headers.get('content-length')) > limits.maxBytes) {
    throw createTooLargeError();
  }
  if (response.body === null) {
    return { data: new Uint8Array(0), contentType };
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  let part = await withTimeout({ work: reader.read(), ms: limits.stallMs, timeoutError: createStalledError });
  while (!part.done) {
    received += part.value.byteLength;
    if (received > limits.maxBytes) {
      throw createTooLargeError();
    }
    parts.push(part.value);
    part = await withTimeout({ work: reader.read(), ms: limits.stallMs, timeoutError: createStalledError });
  }
  return { data: concatBytes(...parts), contentType };
}

function describeHttpStatus(response: Response): string {
  return response.statusText === '' ? String(response.status) : `${String(response.status)} ${response.statusText}`;
}
