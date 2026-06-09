// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { setTimeout as sleep } from "node:timers/promises";

const TRANSIENT = new Set([502, 503, 504]);

// Per-attempt request timeout. The bot side rarely needs more than a few
// seconds, even for pair (attestation and handshake). Without a client-side
// cap, a hung response would silently extend the whole suite.
const PAIR_REQUEST_TIMEOUT_MS = 30_000;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRetry(
  url: string,
  init: RequestInit,
  attempts = 4,
  timeoutMs = PAIR_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  let last: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetchWithTimeout(url, init, timeoutMs);
      if (r.ok || !TRANSIENT.has(r.status) || i === attempts) return r;
      console.warn(
        `[bot] ${init.method ?? "GET"} ${url} → ${r.status} (attempt ${i}/${attempts})`,
      );
    } catch (e) {
      last = e;
      if (i === attempts) throw e;
      console.warn(
        `[bot] ${init.method ?? "GET"} ${url} threw "${(e as Error).message}" (attempt ${i}/${attempts})`,
      );
    }
    await sleep(1_000 * 2 ** (i - 1));
  }
  throw last ?? new Error("fetchRetry exhausted");
}

/**
 * Generate a per-run username for the Nova signing bot.
 *
 * Each test run gets its own throwaway user so network state (allowances,
 * permissions, derived product accounts) doesn't leak between PRs. The
 * format is `dotlitests` followed by 6 lowercase letters, a namespace of
 * roughly 3·10^8 with no collisions in practice. It stays inside the bot's
 * strictest username regex (^[a-z]+$) so it works for both regular
 * `username` and `liteUsername` fields if we ever want one.
 */
export function generateUsername(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `dotlitests${suffix}`;
}

export interface PairResult {
  sessionId: string;
  user: {
    username: string;
    network: string;
    address: string;
    publicKeyHex: string;
    attested?: boolean;
  };
}

/**
 * Pair the bot with a dot.li session via the QR-derived handshake deeplink.
 *
 * The Nova bot's `/api/pair` is one-shot: given a handshake, it
 * (a) creates the user if `username` is new, (b) attests the account on
 * People chain so it has Statement Store allowance, (c) completes the
 * SSO handshake, (d) starts auto-signing future SignRequests for that
 * session. No separate provisioning / poll step needed.
 *
 * `network` should be `paseo-next` for dot.li (Paseo People Next, matching
 * `next-people-paseo` chain spec in packages/config).
 */
export async function pair(
  base: string,
  svcToken: string,
  args: { handshake: string; username: string; network: string },
): Promise<PairResult> {
  const r = await fetchRetry(`${base.replace(/\/$/, "")}/api/pair`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${svcToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) {
    throw new Error(`pair ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as PairResult;
}

/**
 * Tear down a bot session at the end of a test worker.
 *
 * Best-effort. Failure to disconnect is non-fatal, the bot times
 * sessions out anyway.
 */
export async function disconnect(
  base: string,
  svcToken: string,
  sessionId: string,
): Promise<void> {
  await fetchWithTimeout(
    `${base.replace(/\/$/, "")}/api/disconnect`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${svcToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId }),
    },
    PAIR_REQUEST_TIMEOUT_MS,
  ).catch(() => {});
}

export interface BotHealth {
  ok: boolean;
  status?: string;
  uptime?: number;
  error?: string;
}

/**
 * Lightweight bot reachability probe. Used by globalSetup to fail-fast
 * when the bot is unreachable, distinguishing "Nova is down" from
 * "dot.li is broken" in CI output. No auth required.
 */
export async function health(base: string): Promise<BotHealth> {
  try {
    const r = await fetchWithTimeout(
      `${base.replace(/\/$/, "")}/api/health`,
      { method: "GET", headers: { Accept: "application/json" } },
      HEALTH_REQUEST_TIMEOUT_MS,
    );
    if (!r.ok) {
      return { ok: false, error: `${r.status} ${r.statusText}` };
    }
    const body = (await r.json()) as { status?: string; uptime?: number };
    return {
      ok: body.status === "ok",
      status: body.status,
      uptime: body.uptime,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
