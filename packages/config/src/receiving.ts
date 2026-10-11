// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Public build configuration, never provider credentials or enrollment authority. */
export interface ReceivingOriginConfig {
  origin: string;
  relayUrl: string;
  vapidPublicKey: string;
  /** Optional dedicated loopback relay, exposed at this origin's /__receiving. */
  proxyPort?: number;
}

function httpsUrl(value: unknown, field: string): URL {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?(?:\/[A-Za-z0-9/_.~-]*)?$/.test(value)) {
    throw new Error(`Receiving ${field} must be a canonical HTTPS URL without credentials, query, or fragment`);
  }
  const url = new URL(value);
  if (!url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error(`Invalid receiving ${field} hostname`);
  }
  return url;
}

/** Fail the whole configuration closed, rather than silently omitting malformed entries. */
export function parseReceivingOrigins(value: string | undefined): readonly ReceivingOriginConfig[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }
  const entries: unknown = JSON.parse(value);
  if (!Array.isArray(entries)) {
    throw new Error('VITE_RECEIVING_ORIGINS must be a JSON list');
  }
  const origins = new Set<string>();
  const relays = new Set<string>();
  const ports = new Set<number>();
  return entries.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('Receiving origin configuration must be an object');
    }
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some(key => !['origin', 'relayUrl', 'vapidPublicKey', 'proxyPort'].includes(key))) {
      throw new Error('Unknown receiving origin configuration field');
    }
    const origin = httpsUrl(item['origin'], 'origin');
    if (item['origin'] !== origin.origin) {
      throw new Error('Receiving origin must be exact, without a path or trailing slash');
    }
    const relay = httpsUrl(item['relayUrl'], 'relay URL');
    const relayUrl = relay.href.replace(/\/$/, '');
    if (origins.has(origin.origin) || relays.has(relayUrl)) {
      throw new Error('Receiving origins and relay endpoints must be unique; each relay binds one origin/product');
    }
    const vapidPublicKey = item['vapidPublicKey'];
    // A Web Push application-server key is an uncompressed P-256 public point.
    if (typeof vapidPublicKey !== 'string' || !/^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]$/.test(vapidPublicKey)) {
      throw new Error('Receiving vapidPublicKey must be a 65-byte uncompressed public key in unpadded base64url');
    }
    const proxyPort = item['proxyPort'];
    if (proxyPort !== undefined) {
      if (typeof proxyPort !== 'number' || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
        throw new Error('Receiving proxyPort must be an integer from 1 to 65535');
      }
      if (relayUrl !== `${origin.origin}/__receiving` || ports.has(proxyPort)) {
        throw new Error('Each receiving proxy requires its own port and its exact origin /__receiving endpoint');
      }
      ports.add(proxyPort);
    }
    origins.add(origin.origin);
    relays.add(relayUrl);
    return { origin: origin.origin, relayUrl, vapidPublicKey, ...(proxyPort === undefined ? {} : { proxyPort }) };
  });
}

/** No suffix, ancestor, wildcard or first-entry fallback is an authorization. */
export function receivingConfigForOrigin(
  entries: readonly ReceivingOriginConfig[],
  origin: string,
): ReceivingOriginConfig | undefined {
  return entries.find(entry => entry.origin === origin);
}
