// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { describeTransfer } from './chainsFormat.js';

describe('describeTransfer', () => {
  it.each([
    {
      case: 'loads the product',
      transfer: { bytesPerSecond: 512, fetched: 2048, total: 4_194_304 },
      loading: true,
      rows: { speed: { label: 'Speed', value: '512 B/s' }, size: { label: 'Downloading', value: '2 kB / 4.0 MB' } },
    },
    {
      case: 'fetched the whole archive',
      transfer: { bytesPerSecond: 512, fetched: 3_000_000, total: 3_000_000 },
      loading: true,
      rows: { speed: { label: 'Speed', value: '512 B/s' }, size: { label: 'Size', value: '2.9 MB' } },
    },
    {
      case: 'loads from cache, with no total',
      transfer: { bytesPerSecond: 40_000, fetched: null, total: null },
      loading: true,
      rows: { speed: { label: 'Speed', value: '39 kB/s' }, size: null },
    },
    {
      case: 'has a total of zero',
      transfer: { bytesPerSecond: null, fetched: 0, total: 0 },
      loading: true,
      rows: { speed: null, size: null },
    },
    {
      case: 'has the product on screen',
      transfer: { bytesPerSecond: 800, fetched: 4096, total: 4096 },
      loading: false,
      rows: { speed: null, size: null },
    },
  ])('As a user whose page $case, the transfer footer shows what the row says', ({ transfer, loading, rows }) => {
    // When
    const shown = describeTransfer(transfer, loading);

    // Then
    expect(shown).toEqual(rows);
  });
});
