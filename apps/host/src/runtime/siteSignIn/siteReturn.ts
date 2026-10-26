// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether a site vouches for a redirect sign-in's return address. The site lists its return addresses in a well-known
 * file on the address's origin, so a request naming an address the site never listed is answered nowhere.
 */

const WELL_KNOWN_PATH = '/.well-known/polkadot-signin.json';

// A redirect could hand the check to a file the site does not control, and a cached or credentialed read could vouch
// for an address the site has since dropped.
const WELL_KNOWN_FETCH: RequestInit = { credentials: 'omit', redirect: 'error', cache: 'no-store' };

// A list of return addresses is small, so a larger file lists nothing rather than being parsed.
const WELL_KNOWN_MAX_BYTES = 64 * 1024;

export type ReturnVerdict = { ok: true } | { ok: false; reason: 'return_to_not_listed' | 'well_known_unreachable' };

type CheckReturnToDeps = {
  fetch: typeof fetch;
  /** Ends the read, which then counts as unreachable. */
  signal: AbortSignal;
};

/** Reads the well-known file of `returnTo`'s origin and says whether it lists `returnTo`. Never throws. */
export async function checkReturnTo(returnTo: string, deps: CheckReturnToDeps): Promise<ReturnVerdict> {
  const target = normalisedHref(returnTo);
  if (target === null) {
    return { ok: false, reason: 'return_to_not_listed' };
  }
  const file = await readWellKnown(new URL(target).origin, deps);
  if (file === null) {
    return { ok: false, reason: 'well_known_unreachable' };
  }
  if (file === 'too_large') {
    return { ok: false, reason: 'return_to_not_listed' };
  }
  const listed = listedHrefs(file.text);
  if (listed?.includes(target) !== true) {
    return { ok: false, reason: 'return_to_not_listed' };
  }
  return { ok: true };
}

/**
 * The file's text, 'too_large' once more than the cap has arrived, or null when the network, the status, a redirect or
 * the signal kept it from being read.
 */
async function readWellKnown(
  origin: string,
  { fetch: fetchFile, signal }: CheckReturnToDeps,
): Promise<{ text: string } | 'too_large' | null> {
  try {
    const response = await fetchFile(`${origin}${WELL_KNOWN_PATH}`, { ...WELL_KNOWN_FETCH, signal });
    if (!response.ok) {
      return null;
    }
    if (response.body === null) {
      const text = await response.text();
      return new TextEncoder().encode(text).length > WELL_KNOWN_MAX_BYTES ? 'too_large' : { text };
    }
    return await readCapped(response.body.getReader());
  } catch {
    // An unreachable file is a verdict the caller shows and counts, not a failure to report.
    return null;
  }
}

/** Reads the body up to the cap, so a site cannot stream more than the cap before the deadline. */
async function readCapped(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ text: string } | 'too_large'> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.length;
    if (received > WELL_KNOWN_MAX_BYTES) {
      await reader.cancel();
      return 'too_large';
    }
    chunks.push(value);
  }
  const decoder = new TextDecoder();
  const text = chunks.reduce((acc, chunk) => acc + decoder.decode(chunk, { stream: true }), '') + decoder.decode();
  return { text };
}

/** The listed addresses in normalised form, or null when the body is not `{ "return_to": [string, ...] }`. */
function listedHrefs(body: string): string[] | null {
  const data = parseJson(body);
  if (typeof data !== 'object' || data === null || !('return_to' in data)) {
    return null;
  }
  const entries = data.return_to;
  if (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'string')) {
    return null;
  }
  return entries.map(normalisedHref).filter(href => href !== null);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    // A body that is not JSON lists nothing, which is a verdict and not a failure to report.
    return null;
  }
}

function normalisedHref(value: string): string | null {
  try {
    return new URL(value).href;
  } catch {
    // A string that is not a URL names no address, which is a verdict and not a failure to report.
    return null;
  }
}
