// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatSigningHostExit,
  persistentSigningHostSession,
  sanitizeSigningHostOutput,
} from '../e2e/helpers/signing-host-cli.js';

vi.mock(import('node:crypto'), async importOriginal => {
  const actual = await importOriginal();
  const randomUUID = vi.fn();
  return { ...actual, randomUUID, default: { ...actual, randomUUID } };
});

it('reuses the same signing identity across restarts without colliding with another state directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dotli-signing-session-'));
  try {
    vi.mocked(randomUUID)
      .mockReturnValueOnce('01234567-89ab-4cde-8fab-0123456789ab')
      .mockReturnValueOnce('fedcba98-7654-4321-8123-fedcba987654');
    const basePath = join(root, 'first');
    const first = persistentSigningHostSession(basePath);
    vi.resetModules();
    const restarted = await import('../e2e/helpers/signing-host-cli.js');
    expect(restarted.persistentSigningHostSession(basePath)).toBe(first);
    expect(restarted.persistentSigningHostSession(join(root, 'second'))).not.toBe(first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('signing-host diagnostic privacy', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('removes pairing secrets and configured recovery material from failure reports', () => {
    const privateMaterial = 'private signer material used only by this fixture';
    vi.stubEnv('HOST_CLI_SIGNER_MNEMONIC', privateMaterial);
    const output = formatSigningHostExit(
      { code: 1, signal: null },
      `pair polkadotapp://pair?handshake=private-handshake\nsigner ${privateMaterial}\nconnection refused`,
    );
    expect(output).not.toContain('private-handshake');
    expect(output).not.toContain(privateMaterial);
    expect(output).toContain('connection refused');
  });

  it('removes labeled recovery material without discarding subsequent diagnostics', () => {
    const output = sanitizeSigningHostOutput(
      'Recovery phrase: private material\nmnemonic="more private material"\nready',
    );
    expect(output).not.toContain('private material');
    expect(output).toContain('ready');
  });
});
