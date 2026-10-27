// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseRuntimeNetworkConfig } from './readRuntimeNetworkConfig.js';

describe('parseRuntimeNetworkConfig', () => {
  it('As an operator, I give a valid config and get its fields back as I set them', () => {
    // Given
    const networks = { 'paseo-next-v2': { label: 'Fork' } };
    const value = { enabled: ['paseo-next-v2'], networks, baseDomain: 'dot.example' };

    // When
    const config = parseRuntimeNetworkConfig(value);

    // Then
    expect(config).toEqual({ enabled: ['paseo-next-v2'], networks, baseDomain: 'dot.example' });
  });

  it('As an operator, I give an empty config and get no field set', () => {
    // When
    const config = parseRuntimeNetworkConfig({});

    // Then
    expect(config).toEqual({ enabled: undefined, networks: undefined, baseDomain: undefined });
  });

  it.each([
    { name: 'a string', enabled: 'previewnet', found: 'string' },
    { name: 'null', enabled: null, found: 'null' },
    { name: 'an object', enabled: { 0: 'previewnet' }, found: 'object' },
    { name: 'an array with a number', enabled: ['previewnet', 1], found: 'an array with a non-string item' },
  ])(
    'As an operator, I give an `enabled` that is $name and the config is refused with what it found',
    ({ enabled, found }) => {
      // When the config is parsed
      const parse = (): unknown => parseRuntimeNetworkConfig({ enabled });

      // Then the parse throws and names the field
      expect(parse).toThrow(`globalThis.__DOTLI_NETWORK__.enabled must be an array of strings, got ${found}.`);
    },
  );

  it.each([
    { name: 'a number', networks: 1, found: 'number' },
    { name: 'a boolean', networks: true, found: 'boolean' },
    { name: 'null', networks: null, found: 'null' },
    { name: 'a string', networks: 'paseo-next-v2', found: 'string' },
    { name: 'an empty string', networks: '', found: 'string' },
    { name: 'an empty array', networks: [], found: 'an array' },
  ])(
    'As an operator, I give a `networks` that is $name and the config is refused with what it found',
    ({ networks, found }) => {
      // When the config is parsed
      const parse = (): unknown => parseRuntimeNetworkConfig({ networks });

      // Then the parse throws and names the field
      expect(parse).toThrow(`globalThis.__DOTLI_NETWORK__.networks must be an object, got ${found}.`);
    },
  );

  it.each([
    { name: 'a string', value: 'paseo-next-v2', found: 'string' },
    { name: 'a number', value: 1, found: 'number' },
    { name: 'an array', value: [{ enabled: ['paseo-next-v2'] }], found: 'an array' },
    { name: 'null', value: null, found: 'null' },
  ])('As an operator, I set the global to $name and the config is refused with what it found', ({ value, found }) => {
    // When the config is parsed
    const parse = (): unknown => parseRuntimeNetworkConfig(value);

    // Then the parse throws and names the global
    expect(parse).toThrow(`globalThis.__DOTLI_NETWORK__ must be an object, got ${found}.`);
  });
});
