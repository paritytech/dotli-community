// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The sign-in assertion a site verifies, as text the sign-in library parses, and the address it names. */

import { base58 } from '@scure/base';
import { blake2b } from '@dotli/shared';

export interface SiteAssertionFields {
  /** The exact requesting origin. */
  origin: string;
  /** The per-site address, SS58. */
  address: string;
  statement: string | null;
  relayGenesis: string;
  nonce: string;
  /** Milliseconds since the epoch. */
  issuedAt: number;
  username: { name: string; kind: 'lite' | 'full' };
  /** The site's group token, or null for a site of no group. */
  group: string | null;
}

/** How long an assertion stays valid after it is issued. */
export const SITE_ASSERTION_LIFETIME_MS = 5 * 60 * 1000;

const SS58_SALT = new TextEncoder().encode('SS58PRE');

/** The assertion's text, in the Sign-In With Substrate form, with the username and any group as its resources. */
export function formatSiteAssertion(fields: SiteAssertionFields): string {
  const genesis = fields.relayGenesis.startsWith('0x') ? fields.relayGenesis.slice(2) : fields.relayGenesis;
  const lines = [
    `${new URL(fields.origin).host} wants you to sign in with your Substrate account:`,
    fields.address,
    '',
  ];
  if (fields.statement !== null) {
    lines.push(fields.statement, '');
  }
  lines.push(
    `URI: ${fields.origin}`,
    'Version: 1',
    `Chain ID: polkadot:${genesis.slice(0, 32).toLowerCase()}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${new Date(fields.issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(fields.issuedAt + SITE_ASSERTION_LIFETIME_MS).toISOString()}`,
    'Resources:',
    `- urn:dotli:username:${fields.username.kind}:${encodeURIComponent(fields.username.name)}`,
  );
  if (fields.group !== null) {
    lines.push(`- urn:dotli:group:${encodeURIComponent(fields.group)}`);
  }
  return lines.join('\n');
}

function prefixBytes(prefix: number): Uint8Array {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 16383) {
    throw new RangeError(`Invalid SS58 prefix ${String(prefix)}`);
  }
  if (prefix < 64) {
    return Uint8Array.of(prefix);
  }
  return Uint8Array.of(((prefix & 0b1111_1100) >> 2) | 0b0100_0000, (prefix >> 8) | ((prefix & 0b11) << 6));
}

/** The SS58 address of a 32-byte public key under a network's prefix. */
export function encodeSs58(publicKey: Uint8Array, prefix: number): string {
  if (publicKey.length !== 32) {
    throw new RangeError('SS58 needs a 32-byte public key');
  }
  const head = prefixBytes(prefix);
  const data = new Uint8Array(head.length + 32);
  data.set(head);
  data.set(publicKey, head.length);
  const salted = new Uint8Array(SS58_SALT.length + data.length);
  salted.set(SS58_SALT);
  salted.set(data, SS58_SALT.length);
  const checksum = blake2b(salted, 64).subarray(0, 2);
  const full = new Uint8Array(data.length + 2);
  full.set(data);
  full.set(checksum, data.length);
  return base58.encode(full);
}
