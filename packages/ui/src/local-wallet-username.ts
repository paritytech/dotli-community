// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The experimental local wallet's lite username: availability and claims through the network's identity backend,
// reached over the same-origin identity proxy, and confirmation from People chain state. The proofs are built here, from
// the entropy the page already holds, exactly as a native signing host builds them. Only public keys and signatures
// leave the page.

import { x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Bytes, bytesToHex, hexToBytes, Option, Result, str, Tuple, u64 } from '@parity/truapi/scale';
import { ss58Address } from '@polkadot-labs/hdkd-helpers';
import { base64 } from '@scure/base';
import { sign } from '@scure/sr25519';
import initVerifiable, { member as ringVrfMember, sign as ringVrfSign } from 'dotli:truapi-verifiable';
import { getActiveServicesConfig } from '@dotli/config';
import { loadBridge } from './lazy.js';
import { readNetworkLiteUsername } from './local-wallet-identity.js';
import { identityKeypair, indexBytes, junctionChainCode, type Sr25519Pair } from './local-wallet-keys.js';

/** What the People pallet accepts as a lite base: the backend appends the digits. */
export const LITE_USERNAME_BASE = /^[a-z]{6,29}$/;

export type UsernameAvailability =
  | { status: 'available'; digits: readonly number[] }
  /** The backend's own status word, such as `TAKEN`. */
  | { status: 'unavailable'; reason: string };

export type ClaimStage = 'authenticating' | 'submitting' | 'confirming';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const REQUEST_TIMEOUT_MS = 30_000;
const CONFIRM_ATTEMPTS = 30;
const CONFIRM_INTERVAL_MS = 4_000;
const SS58_GENERIC_PREFIX = 42;
/** The People Lite pallet verifies `prefix ‖ candidate ‖ ring_vrf_key`, exact bytes with one space. */
const REGISTER_PREFIX = new TextEncoder().encode('pop:people-lite:register using');
/** `RESERVE_MSG_PREFIX` of the dotNS gateway pallet. */
const RESERVE_PREFIX = new TextEncoder().encode('pop:dotns-gateway:reserve');
/** RFC-0022 keyed-hash roots: the ring-VRF tree and the X25519 ECDH tree. */
const RING_VRF_ROOT_KEY = new TextEncoder().encode('ring-vrf');
const ECDH_ROOT_KEY = new TextEncoder().encode('ecdh');
const CHAT_DOMAIN = new TextEncoder().encode('chat');
/** The lite person is the second member of the network's `peopl.<suffix>` ring-VRF domain. */
const LITE_PERSON_INDEX = 1;

const ConsumerRegistration = Tuple(Bytes(32), Bytes(32), Bytes(65), Bytes(), Option(Bytes()));
const Reservation = Tuple(Bytes(), Bytes(32), Bytes(32), Bytes(), Bytes(), Option(Bytes()), u64);
const MemberResult = Result(Bytes(32), str);
const SignatureResult = Result(Bytes(), str);

function keyedHash(message: Uint8Array, key: Uint8Array): Uint8Array {
  return blake2b(message, { key, dkLen: 32 });
}

function backendBase(): string {
  return getActiveServicesConfig().identityBackendBaseUrl.replace(/\/+$/, '');
}

function stringField(value: unknown, field: string): string {
  const result: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, field) : undefined;
  if (typeof result !== 'string' || result === '') {
    throw new Error(`Identity backend response has no ${field}`);
  }
  return result;
}

async function backendJson(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(`${backendBase()}${path}`, {
    ...init,
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Identity backend ${path} failed (${String(response.status)}): ${text}`);
  }
  return JSON.parse(text) as unknown;
}

function assertBase(base: string): void {
  if (!LITE_USERNAME_BASE.test(base)) {
    throw new Error('A username base is 6 to 29 lowercase letters, without the digits or network suffix');
  }
}

/** The identity keys, refused unless they are the account the running core reports, so a derivation drift fails here. */
function identityKeys(entropy: Uint8Array, identityAccountId: string): Sr25519Pair {
  const keys = identityKeypair(entropy, getActiveServicesConfig().dotns.TLD);
  if (bytesToHex(keys.publicKey) !== identityAccountId.toLowerCase()) {
    throw new Error('The derived identity account does not match the wallet core');
  }
  return keys;
}

/** A bearer token for the identity account: the challenge signed as the backend checks it, covering the `{}` body. */
async function authenticate(keys: Sr25519Pair): Promise<string> {
  const body = '{}';
  const challenge = stringField(
    await backendJson('/auth/challenges', { method: 'POST', headers: JSON_HEADERS, body }),
    'challenge',
  );
  const message = sha256(
    new Uint8Array([...base64.decode(challenge), ...keys.publicKey, ...sha256(new TextEncoder().encode(body))]),
  );
  const token = await backendJson('/auth/token', {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      'Auth-ClientId': base64.encode(keys.publicKey),
      'Auth-ClientProof': base64.encode(sign(keys.secretKey, message)),
      'Auth-Challenge': challenge,
    },
    body,
  });
  return stringField(token, 'token');
}

/** `{ _tag: 'v1', value: { base: { status, availableDigits } } }`, or the older flat `{ base: status }`. */
export function parseAvailability(body: unknown, base: string): UsernameAvailability {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  const flat = record(body)?.[base];
  const entry = record(record(record(body)?.['value'])?.[base]);
  const status = typeof flat === 'string' ? flat : entry?.['status'];
  if (typeof status !== 'string') {
    throw new Error(`Identity backend did not report ${base}`);
  }
  if (status !== 'AVAILABLE') {
    return { status: 'unavailable', reason: status };
  }
  const digits = entry?.['availableDigits'];
  return {
    status: 'available',
    digits: Array.isArray(digits) ? digits.filter((digit): digit is number => Number.isInteger(digit)) : [],
  };
}

export async function checkUsernameAvailability(
  entropy: Uint8Array,
  identityAccountId: string,
  base: string,
): Promise<UsernameAvailability> {
  assertBase(base);
  const token = await authenticate(identityKeys(entropy, identityAccountId));
  const body = await backendJson('/usernames/available?version=v1', {
    method: 'POST',
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ usernames: [base] }),
  });
  return parseAvailability(body, base);
}

/** `Timestamp.Now` on Asset Hub, in seconds: the gateway rejects reservations signed ahead of chain time. */
async function assetHubSeconds(): Promise<bigint> {
  const { hostChainProvider } = await loadBridge();
  const provider = hostChainProvider(getActiveServicesConfig().assethub.genesis);
  if (provider === null) {
    throw new Error('Asset Hub is not reachable on this chain backend');
  }
  const papi = await import('polkadot-api');
  const client = papi.createClient(provider);
  try {
    const now = client.getUnsafeApi().query['Timestamp']?.['Now'];
    if (now === undefined) {
      throw new Error('Asset Hub has no Timestamp.Now storage');
    }
    const millis: unknown = await now.getValue({ at: 'best' });
    if (typeof millis !== 'bigint') {
      throw new Error('Asset Hub Timestamp.Now is not a u64');
    }
    return millis / 1000n;
  } finally {
    client.destroy();
  }
}

function decoded<T>(result: { success: true; value: T } | { success: false; value: string }, what: string): T {
  if (!result.success) {
    throw new Error(`${what} failed: ${result.value}`);
  }
  return result.value;
}

export interface LiteRegistrationInput {
  entropy: Uint8Array;
  keys: Sr25519Pair;
  networkSuffix: string;
  base: string;
  /** The backend's attester, the registration's verifier. */
  verifier: Uint8Array;
  signedAt: bigint;
}

/**
 * The `POST /usernames` body: an sr25519 proof of ownership, the lite person's ring-VRF member key with a plain VRF
 * proof, the chat identifier key, and sr25519 signatures over the consumer registration and the dotNS reservation.
 */
export async function liteRegistrationBody(input: LiteRegistrationInput): Promise<string> {
  const { entropy, keys, base, verifier, signedAt } = input;
  await initVerifiable();
  const domain = keyedHash(keyedHash(entropy, RING_VRF_ROOT_KEY), junctionChainCode(`peopl.${input.networkSuffix}`));
  const vrfEntropy = keyedHash(domain, indexBytes(LITE_PERSON_INDEX));
  const ringVrfKey = decoded(MemberResult.dec(ringVrfMember(vrfEntropy)), 'Ring-VRF member');
  const proofMessage = new Uint8Array([...REGISTER_PREFIX, ...keys.publicKey, ...ringVrfKey]);
  const proofOfOwnership = decoded(SignatureResult.dec(ringVrfSign(vrfEntropy, proofMessage)), 'Ring-VRF');
  if (proofOfOwnership.length !== 64) {
    throw new Error('Ring-VRF proof of ownership is not 64 bytes');
  }

  const chatSecret = keyedHash(
    keyedHash(entropy, ECDH_ROOT_KEY),
    junctionChainCode(String.fromCharCode(...CHAT_DOMAIN)),
  );
  const identifierKey = new Uint8Array(65);
  identifierKey.set(x25519.getPublicKey(chatSecret), 1);

  const username = new TextEncoder().encode(base);
  const hex = (bytes: Uint8Array): string => bytesToHex(bytes);
  const consumer = ConsumerRegistration.enc([keys.publicKey, verifier, identifierKey, username, undefined]);
  const reservation = Reservation.enc([
    RESERVE_PREFIX,
    keys.publicKey,
    verifier,
    username,
    identifierKey,
    undefined,
    signedAt,
  ]);
  return JSON.stringify({
    username: base,
    candidateAccountId: ss58Address(keys.publicKey, SS58_GENERIC_PREFIX),
    candidateSignature: hex(sign(keys.secretKey, proofMessage)),
    ringVrfKey: hex(ringVrfKey),
    proofOfOwnership: hex(proofOfOwnership),
    identifierKey: hex(identifierKey),
    consumerRegistrationSignature: hex(sign(keys.secretKey, consumer)),
    dotns: { signature: hex(sign(keys.secretKey, reservation)), signedAt: Number(signedAt) },
  });
}

/** Resolves with the full lite username once People records it for the identity account. */
export async function claimLiteUsername(
  entropy: Uint8Array,
  identityAccountId: string,
  base: string,
  onStage: (stage: ClaimStage) => void,
): Promise<string> {
  assertBase(base);
  const keys = identityKeys(entropy, identityAccountId);
  onStage('authenticating');
  const attester = stringField(await backendJson('/attester', { method: 'GET' }), 'attester');
  if (!/^0x[0-9a-fA-F]{64}$/.test(attester)) {
    throw new Error('Identity backend attester is not a 32-byte account');
  }
  const token = await authenticate(keys);
  const body = await liteRegistrationBody({
    entropy,
    keys,
    networkSuffix: getActiveServicesConfig().dotns.TLD,
    base,
    verifier: hexToBytes(attester),
    signedAt: await assetHubSeconds(),
  });
  onStage('submitting');
  await backendJson('/usernames', {
    method: 'POST',
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    body,
  });
  onStage('confirming');
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt++) {
    try {
      const name = await readNetworkLiteUsername(identityAccountId);
      if (name !== null) {
        return name;
      }
      lastFailure = undefined;
    } catch (error) {
      // A failed read is retried like a missing name. The claim itself is already submitted.
      lastFailure = error;
    }
    if (attempt < CONFIRM_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, CONFIRM_INTERVAL_MS));
    }
  }
  throw new Error('People did not record the username in time. Check again later; do not claim twice.', {
    cause: lastFailure,
  });
}
