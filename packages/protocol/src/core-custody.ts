// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `Error.name` of a refused `acquire`: another tab of this browser profile holds native Chat custody for the local
 * wallet. Survives the postMessage hop.
 */
export const CORE_CUSTODY_BUSY_ERROR = 'CoreCustodyBusyError';

const CUSTODY_WALLET_DOMAIN = new TextEncoder().encode('dotli:native-core-custody:');

/**
 * Names the local wallet record a custody lease belongs to: a domain-separated SHA-256 of its entropy, so the host
 * frame can check the record it stores still is the wallet the page booted, without the entropy crossing again.
 */
export async function localWalletCustodyId(entropy: Uint8Array): Promise<string> {
  const input = new Uint8Array(CUSTODY_WALLET_DOMAIN.length + entropy.length);
  input.set(CUSTODY_WALLET_DOMAIN);
  input.set(entropy, CUSTODY_WALLET_DOMAIN.length);
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  } finally {
    input.fill(0);
  }
}

/** Host-shell transport only. Never exposed through the product RPC bridge. */
export type CoreCustodyOperation =
  | { action: 'acquire'; wallet: string }
  | { action: 'release'; lease: string }
  | { action: 'read'; lease: string; key: string }
  | { action: 'clear'; lease: string; key: string }
  | { action: 'write'; lease: string; key: string; value: Uint8Array }
  | { action: 'readSource'; lease: string; sourceId: string }
  | { action: 'releaseSource'; lease: string; sourceId: string }
  | {
      action: 'putSources';
      lease: string;
      sources: { sourceId: string; blob: Blob }[];
    };

export function isCoreCustodyOperation(value: unknown): value is CoreCustodyOperation {
  if (typeof value !== 'object' || value === null || !('action' in value)) {
    return false;
  }
  if (value.action === 'acquire') {
    return 'wallet' in value && typeof value.wallet === 'string' && /^[0-9a-f]{64}$/.test(value.wallet);
  }
  if (!('lease' in value) || typeof value.lease !== 'string') {
    return false;
  }
  if (value.action === 'release') {
    return true;
  }
  if (value.action === 'readSource' || value.action === 'releaseSource') {
    return 'sourceId' in value && typeof value.sourceId === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value.sourceId);
  }
  if (value.action === 'putSources') {
    return (
      'sources' in value &&
      Array.isArray(value.sources) &&
      value.sources.length > 0 &&
      value.sources.length <= 32 &&
      value.sources.every(
        (source: unknown) =>
          typeof source === 'object' &&
          source !== null &&
          'sourceId' in source &&
          typeof source.sourceId === 'string' &&
          /^[a-zA-Z0-9-]{1,128}$/.test(source.sourceId) &&
          'blob' in source &&
          source.blob instanceof Blob &&
          source.blob.size <= 0xffff_ffff,
      )
    );
  }
  if (
    !('key' in value) ||
    typeof value.key !== 'string' ||
    !/^[0-9a-f]{2,8192}$/.test(value.key) ||
    value.key.length % 2 !== 0
  ) {
    return false;
  }
  return (
    value.action === 'read' ||
    value.action === 'clear' ||
    (value.action === 'write' &&
      'value' in value &&
      value.value instanceof Uint8Array &&
      value.value.byteLength <= 32 * 1024 * 1024)
  );
}
