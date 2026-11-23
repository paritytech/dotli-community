// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';
import { verify } from '@scure/sr25519';
import { bytesToHex, hexToBytes } from '@parity/truapi/scale';
import initVerifiable, { member } from 'dotli:truapi-verifiable';
import { getActiveServicesConfig } from '@dotli/config';
import { identityKeypair, indexBytes, junctionChainCode } from '../src/local-wallet-keys.js';
import { checkUsernameAvailability, liteRegistrationBody, parseAvailability } from '../src/local-wallet-username.js';
import { blake2b } from '@noble/hashes/blake2.js';

const ENTROPY = new Uint8Array(32).fill(0xab);
const SUFFIX = 'paseo';
const KEYS = identityKeypair(ENTROPY, SUFFIX);
const VERIFIER = new Uint8Array(32).fill(0x11);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

beforeAll(async () => {
  // The glue fetches its wasm by URL in a browser; here it gets the bytes from disk.
  const glue = import.meta.resolve('@parity/truapi-host/wasm/web');
  await initVerifiable({ module_or_path: await readFile(new URL('truapi_verifiable_bg.wasm', glue)) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lite username availability', () => {
  it('reads the versioned and the flat response shapes', () => {
    expect(
      parseAvailability(
        { _tag: 'v1', value: { alicex: { status: 'AVAILABLE', availableDigits: [11, 23] } } },
        'alicex',
      ),
    ).toEqual({ status: 'available', digits: [11, 23] });
    expect(parseAvailability({ alicex: 'TAKEN' }, 'alicex')).toEqual({ status: 'unavailable', reason: 'TAKEN' });
    expect(() => parseAvailability({ _tag: 'v1', value: {} }, 'alicex')).toThrow(/did not report/);
  });

  it('authenticates as the identity account, then asks the backend over the proxy', async () => {
    // Given
    const challenge = base64.encode(text('challenge-bytes'));
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = url.endsWith('/auth/challenges')
        ? { challenge }
        : url.endsWith('/auth/token')
          ? { token: 'tok' }
          : { _tag: 'v1', value: { alicex: { status: 'AVAILABLE', availableDigits: [7] } } };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });

    // When
    const result = await checkUsernameAvailability(ENTROPY, bytesToHex(KEYS.publicKey), 'alicex');

    // Then
    expect(result).toEqual({ status: 'available', digits: [7] });
    const base = getActiveServicesConfig().identityBackendBaseUrl;
    expect(calls.map(call => call.url)).toEqual([
      `${base}/auth/challenges`,
      `${base}/auth/token`,
      `${base}/usernames/available?version=v1`,
    ]);
    const auth = calls[1]?.init.headers as Record<string, string>;
    expect(base64.decode(auth['Auth-ClientId'] ?? '')).toEqual(KEYS.publicKey);
    const signed = sha256(new Uint8Array([...text('challenge-bytes'), ...KEYS.publicKey, ...sha256(text('{}'))]));
    expect(verify(signed, base64.decode(auth['Auth-ClientProof'] ?? ''), KEYS.publicKey)).toBe(true);
    expect(calls[2]?.init.body).toBe('{"usernames":["alicex"]}');
    expect((calls[2]?.init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect(calls.every(call => call.init.credentials === 'omit' && call.init.redirect === 'error')).toBe(true);
  });

  it('refuses a wallet whose derived identity is not the core account', async () => {
    await expect(checkUsernameAvailability(ENTROPY, `0x${'00'.repeat(32)}`, 'alicex')).rejects.toThrow(
      /does not match/,
    );
  });

  it('refuses a base with digits or a suffix before asking anyone', async () => {
    await expect(checkUsernameAvailability(ENTROPY, bytesToHex(KEYS.publicKey), 'alice.42')).rejects.toThrow(
      /lowercase letters/,
    );
  });
});

describe('lite registration body', () => {
  it('carries the proofs the People Lite pallet and the dotNS gateway verify', async () => {
    // When
    const body = JSON.parse(
      await liteRegistrationBody({
        entropy: ENTROPY,
        keys: KEYS,
        networkSuffix: SUFFIX,
        base: 'alicex',
        verifier: VERIFIER,
        signedAt: 1_749_573_123n,
      }),
    ) as Record<string, unknown> & { dotns: { signature: string; signedAt: number } };

    // Then: the member key of the network's lite person, as the core's own ring-VRF module derives it
    const domain = blake2b(blake2b(ENTROPY, { key: text('ring-vrf'), dkLen: 32 }), {
      key: junctionChainCode(`peopl.${SUFFIX}`),
      dkLen: 32,
    });
    const vrfEntropy = blake2b(domain, { key: indexBytes(1), dkLen: 32 });
    const ringVrfKey = member(vrfEntropy).subarray(1);
    expect(body['ringVrfKey']).toBe(bytesToHex(ringVrfKey));
    expect(hexToBytes(body['proofOfOwnership'] as string)).toHaveLength(64);

    const proofMessage = new Uint8Array([...text('pop:people-lite:register using'), ...KEYS.publicKey, ...ringVrfKey]);
    expect(verify(proofMessage, hexToBytes(body['candidateSignature'] as string), KEYS.publicKey)).toBe(true);

    const identifierKey = hexToBytes(body['identifierKey'] as string);
    expect(identifierKey).toHaveLength(65);
    expect(identifierKey[0]).toBe(0);
    expect(identifierKey.subarray(33)).toEqual(new Uint8Array(32));

    // SCALE (account, verifier, identifier key, username, None)
    const consumer = new Uint8Array([...KEYS.publicKey, ...VERIFIER, ...identifierKey, 6 << 2, ...text('alicex'), 0]);
    expect(verify(consumer, hexToBytes(body['consumerRegistrationSignature'] as string), KEYS.publicKey)).toBe(true);

    // SCALE (prefix, candidate, attester, username, chat key, None, signed_at)
    const signedAt = new Uint8Array(8);
    new DataView(signedAt.buffer).setBigUint64(0, 1_749_573_123n, true);
    const reservation = new Uint8Array([
      25 << 2,
      ...text('pop:dotns-gateway:reserve'),
      ...KEYS.publicKey,
      ...VERIFIER,
      6 << 2,
      ...text('alicex'),
      0x05,
      0x01,
      ...identifierKey,
      0,
      ...signedAt,
    ]);
    expect(verify(reservation, hexToBytes(body.dotns.signature), KEYS.publicKey)).toBe(true);
    expect(body.dotns.signedAt).toBe(1_749_573_123);
    expect(body['username']).toBe('alicex');
    expect(typeof body['candidateAccountId']).toBe('string');
  });
});
