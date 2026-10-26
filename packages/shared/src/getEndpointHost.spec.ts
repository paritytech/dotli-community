// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { getEndpointHost } from './getEndpointHost.js';

type Case = {
  label: string;
  endpoint: string | undefined;
  host: string | undefined;
};

describe('getEndpointHost', () => {
  it.each<Case>([
    {
      label: 'a wss endpoint',
      endpoint: 'wss://paseo-asset-hub-next-rpc.polkadot.io',
      host: 'paseo-asset-hub-next-rpc.polkadot.io',
    },
    {
      label: 'an https endpoint with a path and port',
      endpoint: 'https://gateway.example.io:8443/ipfs/',
      host: 'gateway.example.io',
    },
    { label: 'a missing endpoint', endpoint: undefined, host: undefined },
    { label: 'an empty endpoint', endpoint: '', host: undefined },
    // An unparseable value is what an operator typed into the config, so it still helps the visitor.
    { label: 'an unparseable endpoint', endpoint: 'not a url', host: 'not a url' },
  ])('As a caller writing visitor copy, I read the host of $label and get $host', ({ endpoint, host }) => {
    // Given the endpoint of the row

    // When
    const read = getEndpointHost(endpoint);

    // Then
    expect(read).toBe(host);
  });
});
