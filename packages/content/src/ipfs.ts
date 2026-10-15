// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getActiveServicesConfig } from '@dotli/config';
import { endpointHost, named, withTimeout } from '@dotli/shared';
import { concatBytes } from '@noble/hashes/utils.js';

import { CONTENT_ERRORS } from './errors.js';

export interface GatewayLimits {
  /** How long the gateway may send nothing, before its headers or between two parts of its body. */
  stallMs: number;
  /** The most bytes one response may carry, since it is held whole in memory. */
  maxBytes: number;
}

/** A stalled gateway must end in a failure the visitor can retry, not a load that waits forever. */
export const GATEWAY_LIMITS: GatewayLimits = { stallMs: 30_000, maxBytes: 256 * 1024 * 1024 };

export function defaultGateway(): string {
  const [gateway] = getActiveServicesConfig().bulletin.ipfsGateways;
  if (gateway === undefined) {
    throw new Error('No IPFS gateway configured for the active network.');
  }
  return gateway;
}

interface GatewayRequest {
  url: string;
  accept: string;
  cid: string;
  gateway: string;
  /** How a non-ok status is described. */
  failure: string;
}

/** The response body, read part by part so a stall or an oversized body ends the read. */
async function gatewayGet(
  request: GatewayRequest,
  fetchImpl: typeof fetch,
  limits: GatewayLimits,
): Promise<{ data: Uint8Array; contentType: string | undefined }> {
  const host = gatewayHost(request.gateway);
  // Stops the transfer once this read has given up on it.
  const transfer = new AbortController();
  const stalled = (): Error => {
    const err = named(
      new Error(`IPFS gateway ${host} sent nothing for ${String(limits.stallMs)}ms for ${request.cid}`),
      CONTENT_ERRORS.GATEWAY_STALLED,
    );
    transfer.abort(err);
    return err;
  };
  const tooLarge = (): Error => {
    const err = named(
      new Error(`IPFS gateway ${host} sent more than ${String(limits.maxBytes)} bytes for ${request.cid}`),
      CONTENT_ERRORS.GATEWAY_TOO_LARGE,
    );
    transfer.abort(err);
    return err;
  };

  const response = await withTimeout(
    fetchImpl(request.url, { headers: { Accept: request.accept }, signal: transfer.signal }),
    limits.stallMs,
    stalled,
  );
  if (!response.ok) {
    throw new Error(`${request.failure}: HTTP ${httpStatus(response)} from ${host} for ${request.cid}`);
  }
  const contentType = response.headers.get('content-type') ?? undefined;
  if (Number(response.headers.get('content-length')) > limits.maxBytes) {
    throw tooLarge();
  }
  if (response.body === null) {
    return { data: new Uint8Array(0), contentType };
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  let part = await withTimeout(reader.read(), limits.stallMs, stalled);
  while (!part.done) {
    received += part.value.byteLength;
    if (received > limits.maxBytes) {
      throw tooLarge();
    }
    parts.push(part.value);
    part = await withTimeout(reader.read(), limits.stallMs, stalled);
  }
  return { data: concatBytes(...parts), contentType };
}

export async function fetchFromIpfs(
  cid: string,
  gateway: string = defaultGateway(),
  fetchImpl: typeof fetch = fetch,
  limits: GatewayLimits = GATEWAY_LIMITS,
): Promise<{
  data: Uint8Array;
  contentType?: string;
}> {
  // A bare GET lets the gateway content-negotiate and mutate the body, which breaks CID verification.
  const { data, contentType } = await gatewayGet(
    {
      url: `${gateway}/ipfs/${cid}?format=raw`,
      accept: 'application/vnd.ipld.raw',
      cid,
      gateway,
      failure: 'IPFS fetch failed',
    },
    fetchImpl,
    limits,
  );
  return { data, ...(contentType !== undefined ? { contentType } : {}) };
}

export async function fetchCarFromIpfs(
  cid: string,
  gateway: string = defaultGateway(),
  fetchImpl: typeof fetch = fetch,
  limits: GatewayLimits = GATEWAY_LIMITS,
): Promise<Uint8Array> {
  const { data } = await gatewayGet(
    {
      url: `${gateway}/ipfs/${cid}?format=car`,
      accept: 'application/vnd.ipld.car',
      cid,
      gateway,
      failure: 'IPFS CAR fetch failed',
    },
    fetchImpl,
    limits,
  );
  return data;
}

export function gatewayHost(gateway: string): string {
  return endpointHost(gateway) ?? gateway;
}

function httpStatus(response: Response): string {
  return response.statusText === '' ? String(response.status) : `${String(response.status)} ${response.statusText}`;
}
