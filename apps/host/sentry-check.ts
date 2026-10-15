// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Manual check of the Sentry resolution spans the live host sends, on a cold then a warm load.
//
//   node apps/host/sentry-check.ts

/* eslint-disable no-console -- a CLI script: stdout is its output. */

import { chromium, errors, type Browser, type BrowserContext, type Request } from '@playwright/test';

interface Envelope {
  body: string;
  status: number | null;
  req: Request;
}

interface Warm {
  b: Browser;
  ctx: BrowserContext;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {};
}

/** Whether a request body carries what the report below counts: a resolution transaction or a resolution id. */
function carriesResolution(r: Request): boolean {
  const body = r.postData() ?? '';
  return /"transaction":"[^"]*resolution/.test(body) || body.includes('dotli.resolution');
}

const isEnvelope = (r: Request): boolean => r.url().endsWith('/t') && r.method() === 'POST';

async function journey(name: string, warm: Warm | null): Promise<Warm> {
  const b = warm?.b ?? (await chromium.launch());
  const ctx = warm?.ctx ?? (await b.newContext());
  if (warm === null) {
    await ctx.addInitScript(() => {
      localStorage.setItem('dotli:chain-backend', 'smoldot-direct');
    });
  }
  const p = await ctx.newPage();
  const envelopes: Envelope[] = [];
  p.on('request', r => {
    if (r.url().endsWith('/t') && r.method() === 'POST') {
      envelopes.push({ body: r.postData() ?? '', status: null, req: r });
    }
  });
  p.on('response', resp => {
    if (resp.url().endsWith('/t')) {
      const e = envelopes.find(x => x.req === resp.request());
      if (e !== undefined) {
        e.status = resp.status();
      }
    }
  });
  const t0 = Date.now();
  // Listens before the load so a resolution envelope that flushes early is not missed.
  const resolutionSent = p.waitForRequest(r => isEnvelope(r) && carriesResolution(r), { timeout: 180000 });
  await p.goto('https://host-playground.paseoli.dev/', { waitUntil: 'commit' });
  // The host sets this once the product has connected and is the one on screen.
  const rendered = p
    .locator('[data-product-frame="connected"]')
    .waitFor({ state: 'attached', timeout: 180000 })
    .then(() => ((Date.now() - t0) / 1000).toFixed(1));
  const [dur] = await Promise.all([rendered, resolutionSent]);
  // Navigating away fires the pagehide flush that carries the late resolution spans.
  const flushed = p.waitForRequest(r => isEnvelope(r) && carriesResolution(r), { timeout: 10000 });
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
  for (const e of envelopes) {
    for (const line of e.body.split('\n')) {
      if (!line.includes('"transaction"') && !line.includes('dotli.resolution')) {
        continue;
      }
      let j: Json;
      try {
        j = record(JSON.parse(line));
      } catch {
        continue; // Not a JSON line of the envelope.
      }
      const tags = record(j['tags']);
      const data = record(record(record(j['contexts'])['trace'])['data']);
      const transaction = typeof j['transaction'] === 'string' ? j['transaction'] : '';
      const rid = tags['dotli.resolution_id'] ?? data['dotli.resolution_id'];
      if (transaction.includes('resolution') || rid !== undefined) {
        resolutions.push({
          transaction: j['transaction'],
          rid: rid ?? null,
          outcome: data['outcome'] ?? record(j['extra'])['outcome'] ?? null,
          cid_cache: data['cid_cache'] ?? null,
          status: e.status,
        });
      }
    }
  }
  const statuses = [...new Set(envelopes.map(e => String(e.status)))];
  console.log(
    `=== ${name}: rendered in ${dur}s, ${String(envelopes.length)} /t posts, statuses: ${statuses.join(',')}`,
  );
  for (const r of resolutions) {
    console.log(JSON.stringify(r));
  }
  await p.close();
  return { b, ctx };
}

const cold = await journey('cold smoldot-direct', null);
await journey('warm revisit', cold);
await cold.b.close();
