// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Forwarded, OpenParams } from './createOutgoingCalls.js';
import type { Transport } from './createTransport.js';
import type { Address } from './defineSchema.js';
import type { AnyMethod } from './method.js';

/** What a forwarder reaches of the transport it forwards to. */
export type Upstream = {
  /** Where the upstream's schema places `method`. Throws for a method it lacks. */
  addressOf(method: AnyMethod): Address;
  /** Opens a call of the method at `address` that carries `message` as it is. Never throws. */
  open(params: OpenParams): Forwarded;
};

// Each transport this library built, so a forwarder reaches another's calls with no public raw frame API. It is filled
// when a transport is created, never on import.
const upstreams = new WeakMap<Transport<unknown>, Upstream>();

/** Records what a forwarder reaches of `transport`. */
export function registerUpstream(transport: Transport<unknown>, upstream: Upstream): void {
  upstreams.set(transport, upstream);
}

/** What a forwarder reaches of `transport`, or undefined for a transport this library did not build. */
export function getUpstream(transport: Transport<unknown>): Upstream | undefined {
  return upstreams.get(transport);
}
