// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSigningHostExit, sanitizeSigningHostOutput } from '../e2e/helpers/signing-host-cli.js';

describe('signing-host diagnostic privacy', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('removes pairing secrets and configured recovery material from failure reports', () => {
    const privateMaterial = 'private signer material used only by this fixture';
    vi.stubEnv('HOST_CLI_SIGNER_MNEMONIC', privateMaterial);
    const output = formatSigningHostExit({ code: 1, signal: null },
      `pair polkadotapp://pair?handshake=private-handshake\nsigner ${privateMaterial}\nconnection refused`);
    expect(output).not.toContain('private-handshake');
    expect(output).not.toContain(privateMaterial);
    expect(output).toContain('connection refused');
  });

  it('removes labeled recovery material without discarding subsequent diagnostics', () => {
    const output = sanitizeSigningHostOutput('Recovery phrase: private material\nmnemonic="more private material"\nready');
    expect(output).not.toContain('private material');
    expect(output).toContain('ready');
  });
});
