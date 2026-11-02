// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { err, ok } from '@dotli/transport';
import { parseWorkerNetwork, toWorkerName } from './parseWorkerNetwork.js';

describe('parseWorkerNetwork', () => {
  it.each([
    { case: 'a network this build knows', name: 'dotli-protocol-previewnet', network: ok('previewnet') },
    {
      case: 'a network this build does not know',
      name: 'dotli-protocol-nowhere',
      network: err('Unknown protocol network: "nowhere"'),
    },
    {
      case: 'no network',
      name: 'dotli-protocol',
      network: err('Unexpected SharedWorker name "dotli-protocol". The iframe did not encode the active network.'),
    },
  ])('As the shared worker named for $case, I read my name and learn my network or why I have none', row => {
    // Given
    const workerName = row.name;

    // When
    const network = parseWorkerNetwork(workerName);

    // Then
    expect(network).toEqual(row.network);
  });

  it('As the shared worker, I read back the name the iframe built for a network and learn that network', () => {
    // Given
    const builtName = toWorkerName('previewnet');

    // When
    const network = parseWorkerNetwork(builtName);

    // Then
    expect(network).toEqual(ok('previewnet'));
  });
});
