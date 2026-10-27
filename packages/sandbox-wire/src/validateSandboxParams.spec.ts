// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';

import { NetworkName } from '@dotli/config';

import { SANDBOX_CONTRACT_PARAMS, SANDBOX_SCHEMA_VERSION } from './contractParams.js';
import { SandboxContractError } from './sandboxContractError.js';
import { validateSandboxParams } from './validateSandboxParams.js';

const VALID_CID = 'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

/** A row of the missing-param table. */
type MissingParamRow = {
  param: string;
  reason: RegExp;
};

/** The required params, with overrides. `null` removes one. */
function buildSearch(overrides: Record<string, string | null> = {}): URLSearchParams {
  const base: Record<string, string> = {
    [SANDBOX_CONTRACT_PARAMS.cid]: VALID_CID,
    [SANDBOX_CONTRACT_PARAMS.chainBackend]: 'smoldot-direct',
    [SANDBOX_CONTRACT_PARAMS.network]: NetworkName.PASEO,
  };
  const params = new URLSearchParams(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }
  return params;
}

/**
 * Validates and returns the contract error it throws, or undefined when it passes. Any other error propagates.
 * Local because this package may import only `@dotli/config`, so the shared `catchError` is out of reach.
 */
function catchContractError(search: URLSearchParams): SandboxContractError | undefined {
  try {
    validateSandboxParams(search);
  } catch (error) {
    if (error instanceof SandboxContractError) {
      return error;
    }
    throw error;
  }
  return undefined;
}

describe('validateSandboxParams: v3 cid contract', () => {
  it('As the sandbox, when I receive a valid contract, I read cid, backend, and network from the params', () => {
    // Given a contract that carries every required v3 param.
    const search = buildSearch();

    // When the sandbox validates it.
    const params = validateSandboxParams(search);

    // Then the validator surfaces every required value back to the caller.
    expect(params.cid).toBe(VALID_CID);
    expect(params.backend).toBe('smoldot-direct');
    expect(params.network).toBe(NetworkName.PASEO);
  });

  it.each<MissingParamRow>([
    { param: SANDBOX_CONTRACT_PARAMS.cid, reason: /cid/i },
    { param: SANDBOX_CONTRACT_PARAMS.chainBackend, reason: /chainBackend/ },
    { param: SANDBOX_CONTRACT_PARAMS.network, reason: /network/ },
  ])('As the sandbox, I reject a contract that omits the $param', ({ param, reason }) => {
    // Given a contract with one required param removed (the post-boot strip
    // leaves this shape behind, so a reload of a booted sandbox lands here).
    const search = buildSearch({ [param]: null });

    // When the sandbox validates it.
    const error = catchContractError(search);

    // Then it fails with a contract error that names the missing param in its
    // reason and is recoverable, so the boot path asks the host for a fresh
    // contract URL instead of dying on a dead-end error page.
    expect(error).toBeInstanceOf(SandboxContractError);
    expect(error?.message).toMatch(reason);
    expect(error?.recoverable).toBe(true);
  });

  it('As the sandbox, I reject a contract whose cid is the empty string as fatal, since the host explicitly sent a broken value', () => {
    // Given a contract with an empty cid.
    const search = buildSearch({ [SANDBOX_CONTRACT_PARAMS.cid]: '' });

    // When the sandbox validates it.
    const error = catchContractError(search);

    // Then it fails, and is NOT recoverable: an empty value cannot come
    // from the post-boot param strip, so re-rendering from the same host
    // would produce the same empty cid again.
    expect(error).toBeInstanceOf(SandboxContractError);
    expect(error?.recoverable).toBe(false);
  });

  it('As the sandbox, I reject a contract whose cid contains non-alphanumeric characters', () => {
    // Given a contract that smuggles a path-traversal string in `cid`.
    const search = buildSearch({
      [SANDBOX_CONTRACT_PARAMS.cid]: '../etc/passwd',
    });

    // When the sandbox validates it.
    const error = catchContractError(search);

    // Then the charset gate trips before the value reaches any downstream parser.
    expect(error).toBeInstanceOf(SandboxContractError);
    expect(error?.message).toMatch(/invalid cid/i);
  });

  it('As the sandbox, I accept a contract whose schema version matches my build', () => {
    // Given a contract that pins the current schema version.
    const search = buildSearch({
      [SANDBOX_CONTRACT_PARAMS.v]: String(SANDBOX_SCHEMA_VERSION),
    });

    // When the sandbox validates it.
    const params = validateSandboxParams(search);

    // Then it passes.
    expect(params.cid).toBe(VALID_CID);
  });

  it('As the sandbox, I reject a contract whose schema version is older than my build', () => {
    // Given a contract from a host built against an older schema.
    const search = buildSearch({
      [SANDBOX_CONTRACT_PARAMS.v]: String(SANDBOX_SCHEMA_VERSION - 1),
    });

    // When the sandbox validates it.
    const error = catchContractError(search);

    // Then it fails (the version gate protects against stale host deploys).
    expect(error).toBeInstanceOf(SandboxContractError);
  });

  it('As the sandbox, I accept a contract from an older host that still sends a skipArchiveCache value and leave the flag to the host, which owns the archive cache', () => {
    // Given a contract from an older host that still sends the flag, with a
    // value the old validator refused
    const search = buildSearch({ skipArchiveCache: 'yes' });

    // When the sandbox validates it.
    const params = validateSandboxParams(search);

    // Then it passes.
    expect(params.cid).toBe(VALID_CID);
  });

  it('As a user whose dApp reloads itself after the param strip, I land on a recoverable contract failure and the host can restore my session', () => {
    // Given a URL with no contract params at all, which is what a booted
    // sandbox window looks like once its contract params are stripped: a dApp
    // calling location.reload() re-enters the boot with this exact shape.
    const search = new URLSearchParams({ theme: 'dark' });

    // When the sandbox validates it.
    const error = catchContractError(search);

    // Then the failure is recoverable: the host still tracks the rendered
    // label and CID, so it can rebuild the iframe instead of stranding the
    // user on a full-viewport "Invalid sandbox URL" error.
    expect(error).toBeInstanceOf(SandboxContractError);
    expect(error?.recoverable).toBe(true);
  });
});

describe('validateSandboxParams: resolution id', () => {
  it('As the sandbox, I read the resolution id the host threaded through', () => {
    // Given a contract carrying the host correlation id.
    const search = buildSearch({
      [SANDBOX_CONTRACT_PARAMS.resolutionId]: 'f1e2d3c4-b5a6-4778-8899-aabbccddeeff',
    });

    // When the sandbox validates it.
    const params = validateSandboxParams(search);

    // Then the id reaches the caller so it can tag its own telemetry.
    expect(params.resolutionId).toBe('f1e2d3c4-b5a6-4778-8899-aabbccddeeff');
  });

  it.each([
    { kind: 'no resolution id, from a host build that predates it', resolutionId: null },
    { kind: 'a malformed resolution id', resolutionId: '../../etc/passwd' },
    { kind: 'an over-long resolution id', resolutionId: 'a'.repeat(65) },
  ])('As the sandbox, I receive $kind and boot normally, untagged', ({ resolutionId }) => {
    // Given a contract whose resolution id is absent or one the contract does not accept.
    const search = buildSearch({ [SANDBOX_CONTRACT_PARAMS.resolutionId]: resolutionId });

    // When the sandbox validates it.
    const params = validateSandboxParams(search);

    // Then the boot succeeds and the id is dropped. A trace id must never be
    // the reason a product fails to load, nor carry an odd value into telemetry.
    expect(params.resolutionId).toBeNull();
  });
});
