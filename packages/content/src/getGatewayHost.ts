// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getEndpointHost } from '@dotli/shared';

/** The gateway's host for logs and errors, or the gateway as given when it has none. */
export function getGatewayHost(gateway: string): string {
  return getEndpointHost(gateway) ?? gateway;
}
