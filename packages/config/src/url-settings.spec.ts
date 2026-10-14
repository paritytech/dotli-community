// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { parseSettingsFromSearch, writeSettingsToSearch } from './url-settings.js';
import { NetworkName } from './network.js';

describe('parseSettingsFromSearch', () => {
  it('As a visitor, I open a URL with no or invalid settings and none of them apply', () => {
    // When
    const empty = parseSettingsFromSearch(new URLSearchParams());

    // Then
    expect(empty).toEqual({
      network: null,
      backend: null,
      skipArchiveCache: null,
      skipCidCache: null,
      skipWorkerCache: null,
    });

    // When
    const invalid = parseSettingsFromSearch(new URLSearchParams('network=bogus&chainBackend=nope&skipCidCache=true'));

    // Then
    expect(invalid.network).toBeNull();
    expect(invalid.backend).toBeNull();
    expect(invalid.skipCidCache).toBeNull();
  });

  it('As a visitor, I open a URL with a valid value on every setting and each applies', () => {
    // When
    const parsed = parseSettingsFromSearch(
      new URLSearchParams(
        `network=${NetworkName.PASEO}&chainBackend=rpc-gateway&skipArchiveCache=0&skipCidCache=1&skipWorkerCache=1`,
      ),
    );

    // Then
    expect(parsed.network).toBe(NetworkName.PASEO);
    expect(parsed.backend).toBe('rpc-gateway');
    expect(parsed.skipArchiveCache).toBe(false);
    expect(parsed.skipCidCache).toBe(true);
    expect(parsed.skipWorkerCache).toBe(true);
  });

  it('As a visitor, I open a URL asking for the shared light client and it parses as written', () => {
    // When
    const parsed = parseSettingsFromSearch(new URLSearchParams('chainBackend=smoldot-shared-worker'));

    // Then
    expect(parsed.backend).toBe('smoldot-shared-worker');
  });
});

describe('writeSettingsToSearch against the smoldot-direct default', () => {
  it('As a visitor on the per-tab light client, I see it dropped from the URL, as it is the default with or without SharedWorker', () => {
    // Given
    const search = new URLSearchParams('chainBackend=smoldot-direct');

    // When
    const changed = writeSettingsToSearch(
      {
        network: NetworkName.PREVIEWNET,
        backend: 'smoldot-direct',
        cache: {
          skipCidCache: true,
          skipArchiveCache: true,
          skipWorkerCache: false,
        },
      },
      search,
    );

    // Then
    expect(changed).toBe(true);
    expect(search.get('chainBackend')).toBeNull();
  });

  it('As a visitor on the shared light client, I see it kept in the URL, as the default is the per-tab one', () => {
    // Given
    const search = new URLSearchParams();

    // When
    writeSettingsToSearch(
      {
        network: NetworkName.PREVIEWNET,
        backend: 'smoldot-shared-worker',
        cache: {
          skipCidCache: true,
          skipArchiveCache: true,
          skipWorkerCache: false,
        },
      },
      search,
    );

    // Then
    expect(search.get('chainBackend')).toBe('smoldot-shared-worker');
  });
});

describe('writeSettingsToSearch', () => {
  it('As a visitor back on the default settings, I see them dropped from the URL and its other parameters kept', () => {
    // Given
    const search = new URLSearchParams('network=previewnet&chainBackend=rpc-gateway&skipArchiveCache=1&keep=me');

    // When
    const changed = writeSettingsToSearch(
      {
        network: NetworkName.PASEO,
        backend: 'smoldot-direct',
        cache: {
          skipCidCache: false,
          skipArchiveCache: false,
          skipWorkerCache: false,
        },
      },
      search,
    );

    // Then
    expect(changed).toBe(true);
    expect(search.get('network')).toBeNull();
    expect(search.get('chainBackend')).toBeNull();
    expect(search.get('skipArchiveCache')).toBeNull();
    expect(search.get('skipWorkerCache')).toBeNull();
    expect(search.get('keep')).toBe('me');
  });

  it('As a visitor on settings other than the defaults, I see them written to the URL with booleans as 1', () => {
    // Given
    const search = new URLSearchParams();

    // When
    writeSettingsToSearch(
      {
        network: NetworkName.PREVIEWNET,
        backend: 'smoldot-direct',
        cache: {
          skipCidCache: true,
          skipArchiveCache: false,
          skipWorkerCache: false,
        },
      },
      search,
    );

    // Then
    expect(search.get('network')).toBe(NetworkName.PREVIEWNET);
    expect(search.get('chainBackend')).toBeNull();
    expect(search.get('skipCidCache')).toBe('1');
    expect(search.get('skipArchiveCache')).toBeNull();
    expect(search.get('skipWorkerCache')).toBeNull();
  });
});
