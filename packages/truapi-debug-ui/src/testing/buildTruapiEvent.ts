// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { TruapiDebugMessageEvent } from '@dotli/truapi-debug';

export type BuildTruapiEventParams = {
  tag?: string;
  requestId?: string;
  direction?: TruapiDebugMessageEvent['direction'];
  /** `null` builds a message without a product id. */
  productId?: string | null;
  value?: unknown;
};

/**
 * A TrUAPI message as the bus carries it: an outgoing `example_request` of `app.dot` with an empty value, apart from
 * what `params` sets. Never throws.
 */
export function buildTruapiEvent({
  tag = 'example_request',
  requestId = 'request-1',
  direction = 'outgoing',
  productId = 'app.dot',
  value = {},
}: BuildTruapiEventParams = {}): TruapiDebugMessageEvent {
  return {
    kind: 'truapi',
    direction,
    ...(productId === null ? {} : { productId }),
    requestId,
    payload: { tag, value },
  };
}
