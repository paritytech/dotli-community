// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { err, ok } from '@dotli/transport';
import { parseWorkerNetwork, toWorkerName } from './parseWorkerNetwork.js';

describe('parseWorkerNetwork', () => {
  it('As the shared worker named for a network this build does not know, I read my name and learn why I have none', () => {
    // Given
    const workerName = 'dotli-protocol-nowhere';

    // When
    const network = parseWorkerNetwork(workerName);

    // Then
    expect(network).toEqual(err('Unknown protocol network in the worker name "dotli-protocol-nowhere"'));
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
