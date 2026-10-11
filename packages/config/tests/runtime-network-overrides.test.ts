// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as NetworkModule from '../src/network.js';

const RUNTIME_GLOBAL_KEY = '__DOTLI_NETWORK__';

/** The table is built once at module init, so each case loads a fresh module under its own runtime config. */
async function loadWithOverride(networks: Record<string, unknown>): Promise<typeof NetworkModule> {
  vi.resetModules();
  (globalThis as Record<string, unknown>)[RUNTIME_GLOBAL_KEY] = { networks };
  return import('../src/network.js');
}

async function identityBackendFor(value: unknown): Promise<string> {
  const { NETWORK_NAME_TO_SERVICES_CONFIG, NetworkName } = await loadWithOverride({
    'paseo-next-v2': { identityBackendBaseUrl: value },
  });
  return NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO].identityBackendBaseUrl;
}

const REJECTION = /identityBackendBaseUrl must be a root-relative proxy path or an HTTPS base URL/;

describe('runtime network overrides', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, RUNTIME_GLOBAL_KEY);
  });

  it('As an operator, the built-in identity backends are the same-origin proxy paths', async () => {
    // Given / When
    const { NETWORK_NAME_TO_SERVICES_CONFIG, NetworkName } = await loadWithOverride({});

    // Then
    expect(NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO].identityBackendBaseUrl).toBe('/__dotli-identity/paseo');
    expect(NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PREVIEWNET].identityBackendBaseUrl).toBe(
      '/__dotli-identity/testnet',
    );
  });

  it('As an operator, I can point a network at another proxy path or HTTPS backend', async () => {
    expect(await identityBackendFor('/identity/paseo/')).toBe('/identity/paseo');
    expect(await identityBackendFor('https://identity.example/api/v1/')).toBe('https://identity.example/api/v1');
    expect(await identityBackendFor('https://identity.example')).toBe('https://identity.example');
  });

  it('As an operator, a local backend may use plain HTTP on loopback only', async () => {
    expect(await identityBackendFor('http://localhost:8080/api/v1')).toBe('http://localhost:8080/api/v1');
    expect(await identityBackendFor('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(await identityBackendFor('http://[::1]:8080')).toBe('http://[::1]:8080');
    await expect(identityBackendFor('http://identity.example/api/v1')).rejects.toThrow(REJECTION);
  });

  it('As an operator, a backend URL with credentials, query, fragment or a foreign scheme is refused', async () => {
    for (const value of [
      'https://user:secret@identity.example/api/v1',
      'https://identity.example/api/v1?x=1',
      'https://identity.example/api/v1#x',
      '/__dotli-identity/paseo?version=v1',
      'javascript:alert(1)',
      'ftp://identity.example',
    ]) {
      await expect(identityBackendFor(value), value).rejects.toThrow(REJECTION);
    }
  });

  it('As an operator, protocol-relative and bare relative paths are refused rather than resolved', async () => {
    for (const value of ['//identity.example/api/v1', '/\\identity.example', 'identity/paseo', '']) {
      await expect(identityBackendFor(value), value).rejects.toThrow(REJECTION);
    }
  });

  it('As an operator, a non-string backend is refused', async () => {
    await expect(identityBackendFor(42)).rejects.toThrow(/identityBackendBaseUrl must be a string/);
  });

  it('As an operator, the refusal never echoes the configured URL', async () => {
    await expect(identityBackendFor('https://user:secret@identity.example')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret') as unknown }),
    );
  });

  it('As an operator, unknown network fields still name identityBackendBaseUrl among the valid ones', async () => {
    await expect(loadWithOverride({ 'paseo-next-v2': { identityBackend: '/x' } })).rejects.toThrow(
      /identityBackend is not overridable\. Valid fields: label, identityBackendBaseUrl, relay/,
    );
  });
});
