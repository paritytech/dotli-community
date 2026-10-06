// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Mint short-lived Cloudflare TURN credentials for the host Media service at
// deploy time and hand them to the production build.
//
// The browser Media backend gathers relay candidates only, so calls need a
// TURN relay. The Deploy workflow runs this immediately before `build:prod`:
//
//   node scripts/mint-media-turn.ts
//
// With DOTLI_TURN_CLOUDFLARE_KEY_ID and DOTLI_TURN_CLOUDFLARE_API_TOKEN set,
// it requests credentials valid for 48 hours (Cloudflare's maximum), keeps only
// credentialed turn:/turns: URLs (no STUN, no port 53), masks the credential in
// the job log, and appends VITE_MEDIA_ICE_SERVERS to $GITHUB_ENV. The bundle
// carries those relay credentials; the API token stays in this process. A
// redeploy refreshes expired credentials.
//
// Without the secrets it emits a warning annotation and leaves the variable
// unset, so the build has no relay and calls cannot connect. A configured but
// failing mint exits 1 rather than ship a build that silently cannot call.

import { appendFileSync } from 'node:fs';

/** Cloudflare's maximum credential lifetime, in seconds (48 hours). */
export const TURN_CREDENTIAL_TTL_SECONDS = 172_800;

export interface MediaIceServer {
  urls: string[];
  username: string;
  credential: string;
}

/** Port 53 relays are blocked by many networks and collide with DNS filtering. */
const PORT_53 = /^turns?:(?:\[[^\]]*\]|[^:?]*):53(?:\?|$)/i;

/**
 * Converts Cloudflare's `credentials/generate` response into the
 * `RTCIceServer[]` the host accepts (`parseMediaIceServers`). Accepts both the
 * array and the older single-object `iceServers` shapes.
 */
export function toMediaIceServers(response: unknown): MediaIceServer[] {
  const raw = (response as { iceServers?: unknown } | null)?.iceServers;
  const entries: unknown[] = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const servers = entries.flatMap((entry): MediaIceServer[] => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const { urls, username, credential } = entry as Record<string, unknown>;
    if (typeof username !== 'string' || username === '' || typeof credential !== 'string' || credential === '') {
      return [];
    }
    const list = (typeof urls === 'string' ? [urls] : Array.isArray(urls) ? urls : []).filter(
      (url): url is string => typeof url === 'string' && /^turns?:/i.test(url) && !PORT_53.test(url),
    );
    return list.length === 0 ? [] : [{ urls: list, username, credential }];
  });
  if (servers.length === 0) {
    throw new Error('Cloudflare returned no credentialed turn:/turns: relay');
  }
  return servers;
}

export async function mintMediaIceServers(
  keyId: string,
  apiToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MediaIceServer[]> {
  const response = await fetchImpl(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    // The body is not echoed: it is untrusted and could reflect request data.
    throw new Error(`Cloudflare TURN credential request failed: HTTP ${String(response.status)}`);
  }
  return toMediaIceServers(await response.json());
}

/** GitHub Actions workflow commands that mask, then export, the build value. */
export function githubEnvExport(servers: readonly MediaIceServer[]): { log: string[]; env: string } {
  const value = JSON.stringify(servers);
  const secrets = new Set([...servers.flatMap(server => [server.credential, server.username]), value]);
  return {
    log: [...secrets].map(secret => `::add-mask::${secret}`),
    env: `VITE_MEDIA_ICE_SERVERS=${value}\n`,
  };
}

if (import.meta.main) {
  const keyId = process.env['DOTLI_TURN_CLOUDFLARE_KEY_ID'] ?? '';
  const apiToken = process.env['DOTLI_TURN_CLOUDFLARE_API_TOKEN'] ?? '';
  const githubEnv = process.env['GITHUB_ENV'] ?? '';
  if (keyId === '' || apiToken === '') {
    console.log(
      '::warning title=No Media TURN relay::DOTLI_TURN_CLOUDFLARE_KEY_ID/DOTLI_TURN_CLOUDFLARE_API_TOKEN are not set; host Media calls cannot connect in this build.',
    );
    process.exit(0);
  }
  if (githubEnv === '') {
    console.error('GITHUB_ENV is not set; refusing to print TURN credentials.');
    process.exit(1);
  }
  try {
    const servers = await mintMediaIceServers(keyId, apiToken);
    const { log, env } = githubEnvExport(servers);
    for (const line of log) {
      console.log(line);
    }
    appendFileSync(githubEnv, env);
    console.log(
      `Minted ${String(servers.length)} Media TURN relay entr${servers.length === 1 ? 'y' : 'ies'}, valid ${String(TURN_CREDENTIAL_TTL_SECONDS / 3600)} h.`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
