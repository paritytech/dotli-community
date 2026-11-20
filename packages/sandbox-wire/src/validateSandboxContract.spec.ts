// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';

import { SANDBOX_SCHEMA_VERSION } from './contractParams.js';
import { SandboxContractError } from './sandboxContractError.js';
import type { SandboxContractMessage } from './sandboxMessages.js';
import { validateSandboxContract } from './validateSandboxParams.js';

const VALID_CID = 'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

/** A well-formed contract reply, with overrides. A field the host never sent is modelled by omission, not a value. */
function buildContract(overrides: Partial<SandboxContractMessage> = {}): SandboxContractMessage {
  return {
    type: 'dotli:sandbox-contract',
    cid: VALID_CID,
    chainBackend: 'smoldot-direct',
    network: 'paseo-next-v2',
    v: String(SANDBOX_SCHEMA_VERSION),
    ...overrides,
  };
}

/**
 * Validates and returns the contract error it throws, or undefined when it passes. Any other error propagates.
 * Local because this package may import only `@dotli/config`, so the shared `catchError` is out of reach.
 */
function catchContractError(contract: SandboxContractMessage): SandboxContractError | undefined {
  try {
    validateSandboxContract(contract);
  } catch (error) {
    if (error instanceof SandboxContractError) {
      return error;
    }
    throw error;
  }
  return undefined;
}

describe('validateSandboxContract', () => {
  it('As the sandbox, when the host replies with a valid contract, I read every field from the message', () => {
    // Given the host's reply to a contract request.
    const contract = buildContract({ fullReset: '1', resolutionId: 'f1e2d3c4-b5a6-4778-8899-aabbccddeeff' });

    // When the sandbox validates it.
    const params = validateSandboxContract(contract);

    // Then every value reaches the caller, read off the message rather than the URL.
    expect(params).toEqual({
      cid: VALID_CID,
      backend: 'smoldot-direct',
      network: 'paseo-next-v2',
      fullReset: true,
      resolutionId: 'f1e2d3c4-b5a6-4778-8899-aabbccddeeff',
    });
  });

  it('As the sandbox, I treat a contract that omits a required field as a recoverable failure', () => {
    // Given a reply whose content id never arrived (a field dropped on receipt reads the same).
    const contract: SandboxContractMessage = {
      type: 'dotli:sandbox-contract',
      chainBackend: 'smoldot-direct',
      network: 'paseo-next-v2',
      v: String(SANDBOX_SCHEMA_VERSION),
    };

    // When the sandbox validates it.
    const error = catchContractError(contract);

    // Then it fails recoverably, naming the missing field, so the boot path re-asks the host instead of dying.
    expect(error).toBeInstanceOf(SandboxContractError);
    expect(error?.message).toMatch(/cid/i);
    expect(error?.recoverable).toBe(true);
  });

  it('As the sandbox, I treat a present but invalid field as a fatal failure', () => {
    // Given a reply that smuggles a path-traversal string in cid.
    const contract = buildContract({ cid: '../etc/passwd' });

    // When the sandbox validates it.
    const error = catchContractError(contract);

    // Then a present but broken value means a broken host build, so it stays fatal.
    expect(error).toBeInstanceOf(SandboxContractError);
    expect(error?.recoverable).toBe(false);
  });

  it('As the sandbox, I reject a contract whose schema version is older than my build', () => {
    // Given a reply from a host built against an older schema.
    const contract = buildContract({ v: String(SANDBOX_SCHEMA_VERSION - 1) });

    // When the sandbox validates it.
    const error = catchContractError(contract);

    // Then the version gate protects against stale host deploys.
    expect(error).toBeInstanceOf(SandboxContractError);
  });
});
