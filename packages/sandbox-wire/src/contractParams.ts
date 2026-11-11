// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports nothing, so its own entry loads in Node, where the package's main entry cannot.

export const SANDBOX_SCHEMA_VERSION = 3;

/**
 * Shared by the host writer, this validator and the sandbox's post-validation strip, so the wire format never drifts.
 */
export const SANDBOX_CONTRACT_PARAMS = {
  cid: 'cid',
  chainBackend: 'chainBackend',
  network: 'network',
  fullReset: 'fullReset',
  resolutionId: 'resolutionId',
  v: 'v',
} as const;

/** The contract params by name, for the raw query strip. */
const CONTRACT_KEYS: ReadonlySet<string> = new Set(Object.values(SANDBOX_CONTRACT_PARAMS));

/**
 * Returns `search` without its leading `?` and without each part whose key names a contract param. Every other part is
 * kept byte for byte and in order, so the product reads its query as it was typed. A key is compared form-decoded, so
 * an escaped name counts. Never throws.
 */
export function removeContractParams(search: string): string {
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (query === '') {
    return '';
  }
  return query
    .split('&')
    .filter(part => !CONTRACT_KEYS.has(decodeKey(part)))
    .join('&');
}

// Byte by byte, which reads every ASCII name as a form decoder does, and a malformed escape stays as written.
function decodeKey(part: string): string {
  const separator = part.indexOf('=');
  const key = separator === -1 ? part : part.slice(0, separator);
  return key
    .replaceAll('+', ' ')
    .replace(/%([0-9A-Fa-f]{2})/g, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}
