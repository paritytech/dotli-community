// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  RUNTIME_NETWORK_CONFIG_HEADERS,
  RUNTIME_NETWORK_CONFIG_PATH,
  runtimeNetworkConfigScriptBody,
} from './runtime-network-config-plugin.js';
import { nginxHeaders } from './testing/nginx.js';

describe('runtimeNetworkConfigScriptBody', () => {
  it('As an operator, I set DOTLI_NETWORK and the page receives my config as written', () => {
    // Given
    const raw = ' {"enabled":["previewnet"]} ';

    // When
    const body = runtimeNetworkConfigScriptBody(raw);

    // Then
    expect(body).toBe('window.__DOTLI_NETWORK__ = {"enabled":["previewnet"]};\n');
  });

  it('As an operator, I leave DOTLI_NETWORK unset or blank and the page keeps the built-in networks', () => {
    // When
    const bodies = [runtimeNetworkConfigScriptBody(undefined), runtimeNetworkConfigScriptBody('  ')];

    // Then
    expect(bodies).toEqual(['window.__DOTLI_NETWORK__ = {};\n', 'window.__DOTLI_NETWORK__ = {};\n']);
  });

  it('As an operator, I set a DOTLI_NETWORK that is not JSON and am told which variable is wrong', () => {
    // Given
    const raw = '{"enabled":';

    // When
    const read = (): string => runtimeNetworkConfigScriptBody(raw);

    // Then
    expect(read).toThrow(/DOTLI_NETWORK is not valid JSON/);
  });
});

describe('the config script against nginx', () => {
  it("As an operator, I run a Node server and the config script carries the container nginx's headers", () => {
    // Given
    const nginx = nginxHeaders('docker/dotli-runtime-network.conf');

    // When
    const headers = { ...RUNTIME_NETWORK_CONFIG_HEADERS };

    // Then
    expect(headers).toEqual(nginx);
    expect(RUNTIME_NETWORK_CONFIG_PATH).toBe('/dotli-network.js');
  });

  it('As another site, I cannot read the config, which may name private endpoints', () => {
    // When
    const headers = { ...RUNTIME_NETWORK_CONFIG_HEADERS };

    // Then
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(headers).not.toHaveProperty('Access-Control-Allow-Origin');
    expect(headers).not.toHaveProperty('Access-Control-Allow-Private-Network');
  });
});
