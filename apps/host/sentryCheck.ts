// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Manual check of the Sentry resolution spans the live host sends, on a cold then a warm load.
//
//   node apps/host/sentryCheck.ts

/* eslint-disable no-console -- a CLI script: stdout is its output. */

import { chromium, errors, type BrowserContext, type Request } from '@playwright/test';

type Envelope = {
  body: string;
  status: number | null;
};

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {};
}

function isEnvelope(r: Request): boolean {
  return r.url().endsWith('/t') && r.method() === 'POST';
}

/** Whether `r` is an envelope with a line the report below counts. */
function carriesResolution(r: Request): boolean {
  return isEnvelope(r) && (r.postData() ?? '').split('\n').some(line => readResolution(line, null) !== null);
}

/** The resolution one line of an envelope reports, or null for a line that reports none. */
function readResolution(line: string, status: number | null): Json | null {
  let j: Json;
  try {
    j = record(JSON.parse(line));
  } catch {
    return null; // Not a JSON line of the envelope.
  }
  const tags = record(j['tags']);
  const data = record(record(record(j['contexts'])['trace'])['data']);
  const transaction = typeof j['transaction'] === 'string' ? j['transaction'] : '';
  const rid = tags['dotli.resolution_id'] ?? data['dotli.resolution_id'];
  if (!transaction.includes('resolution') && rid === undefined) {
    return null;
  }
  return {
    transaction: j['transaction'],
    rid: rid ?? null,
    outcome: data['outcome'] ?? record(j['extra'])['outcome'] ?? null,
    cid_cache: data['cid_cache'] ?? null,
    status,
  };
}

/** Loads the live host in `ctx` and prints the resolutions its envelopes report. */
async function journey(name: string, ctx: BrowserContext): Promise<void> {
  const p = await ctx.newPage();
  const envelopes = new Map<Request, Envelope>();
  p.on('request', r => {
    if (isEnvelope(r)) {
      envelopes.set(r, { body: r.postData() ?? '', status: null });
    }
  });
  p.on('response', resp => {
    const e = envelopes.get(resp.request());
    if (e !== undefined) {
      e.status = resp.status();
    }
  });
  const t0 = Date.now();
  // Listens before the load so a resolution envelope that flushes early is not missed.
  const resolutionSent = p.waitForRequest(carriesResolution, { timeout: 180000 });
  await p.goto('https://host-playground.paseoli.dev/', { waitUntil: 'commit' });
  // The host sets this once the product has connected and is the one on screen.
  const rendered = p
    .locator('[data-product-frame="connected"]')
    .waitFor({ state: 'attached', timeout: 180000 })
    .then(() => ((Date.now() - t0) / 1000).toFixed(1));
  const [dur] = await Promise.all([rendered, resolutionSent]);
  // Navigating away fires the pagehide flush that carries the late resolution spans.
  const flushed = p.waitForRequest(carriesResolution, { timeout: 10000 });
  await p.goto('about:blank');
  try {
    await flushed;
  } catch (e) {
    if (!(e instanceof errors.TimeoutError)) {
      throw e;
    }
    console.log(`${name}: no pagehide flush carried a resolution`);
  }

  const resolutions: Json[] = [];
  for (const e of envelopes.values()) {
    for (const line of e.body.split('\n')) {
      const resolution = readResolution(line, e.status);
      if (resolution !== null) {
        resolutions.push(resolution);
      }
    }
  }
  const statuses = [...new Set([...envelopes.values()].map(e => String(e.status)))];
  console.log(`=== ${name}: rendered in ${dur}s, ${String(envelopes.size)} /t posts, statuses: ${statuses.join(',')}`);
  for (const r of resolutions) {
    console.log(JSON.stringify(r));
  }
  await p.close();
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  localStorage.setItem('dotli:chain-backend', 'smoldot-direct');
});
await journey('cold smoldot-direct', ctx);
await journey('warm revisit', ctx);
await browser.close();
