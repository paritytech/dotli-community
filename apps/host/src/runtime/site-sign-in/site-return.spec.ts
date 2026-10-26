// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { checkReturnTo } from './site-return.js';

type FetchCall = {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
};

/**
 * A fetch that answers every request with `respond()`, or rejects with the signal's reason once it is aborted, as the
 * page's fetch does, and records what it was asked.
 */
const fakeFetch = (respond: () => Promise<Response>) => {
  const calls: FetchCall[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    if (init?.signal?.aborted === true) {
      return Promise.reject(init.signal.reason as Error);
    }
    return respond();
  };
  return { fetch, calls };
};

// A read no deadline has cut short.
const signal = new AbortController().signal;

const serving = (body: string, status = 200) => fakeFetch(() => Promise.resolve(new Response(body, { status })));

const listing = (...entries: unknown[]) => serving(JSON.stringify({ return_to: entries }));

describe('site return address', () => {
  it('As a site, I list my return address and the window accepts it', async () => {
    // Given a well-known file that lists the return address
    const { fetch } = listing('https://a.example/back');

    // When the return address is checked
    const verdict = await checkReturnTo('https://a.example/back', { fetch, signal });

    // Then it is accepted
    expect(verdict).toEqual({ ok: true });
  });

  it('As a site, I list my origin without its slash and the window accepts the same address with it', async () => {
    // Given a well-known file that lists the bare origin
    const { fetch } = listing('https://a.example');

    // When the origin's root with its slash is checked
    const verdict = await checkReturnTo('https://a.example/', { fetch, signal });

    // Then both read as one address
    expect(verdict).toEqual({ ok: true });
  });

  it('As a site, I list other addresses and the window refuses the one I did not list', async () => {
    // Given a well-known file that lists another path and an entry that is no URL
    const { fetch } = listing('https://a.example/other', 'not a url');

    // When an unlisted return address is checked
    const verdict = await checkReturnTo('https://a.example/back', { fetch, signal });

    // Then it is not listed
    expect(verdict).toEqual({ ok: false, reason: 'return_to_not_listed' });
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    ['a list that is not an array', JSON.stringify({ return_to: 'https://a.example/back' })],
    ['a list with a non-string entry', JSON.stringify({ return_to: ['https://a.example/back', 7] })],
    ['an array at the top', JSON.stringify(['https://a.example/back'])],
    ['JSON null', 'null'],
  ])('As a site, I serve %s and the window reads it as not listing the address', async (_name, body) => {
    // Given a well-known file of the wrong shape
    const { fetch } = serving(body);

    // When the return address is checked
    const verdict = await checkReturnTo('https://a.example/back', { fetch, signal });

    // Then it is not listed
    expect(verdict).toEqual({ ok: false, reason: 'return_to_not_listed' });
  });

  it('As a site, I serve no well-known file and the window reads it as unreachable', async () => {
    // Given a site that answers 404
    const { fetch } = serving('missing', 404);

    // When the return address is checked
    const verdict = await checkReturnTo('https://a.example/back', { fetch, signal });

    // Then the file is unreachable
    expect(verdict).toEqual({ ok: false, reason: 'well_known_unreachable' });
  });

  it('As a site, I redirect the well-known file or fail the network and the window reads it as unreachable', async () => {
    // Given a fetch that rejects, as a refused redirect does
    const { fetch } = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));

    // When the return address is checked
    const verdict = await checkReturnTo('https://a.example/back', { fetch, signal });

    // Then the file is unreachable and nothing throws
    expect(verdict).toEqual({ ok: false, reason: 'well_known_unreachable' });
  });

  it('As a site whose well-known file takes too long, I am read as unreachable', async () => {
    // Given a deadline already past
    const { fetch } = listing('https://a.example/back');
    const timedOut = AbortSignal.abort(new DOMException('The read timed out', 'TimeoutError'));

    // When the return address is checked
    const verdict = await checkReturnTo('https://a.example/back', { fetch, signal: timedOut });

    // Then the file is unreachable and nothing throws
    expect(verdict).toEqual({ ok: false, reason: 'well_known_unreachable' });
  });

  it('As a site, I serve a well-known file over 64 KiB and the window reads it as not listing the address', async () => {
    // Given a file that lists the return address, padded past 64 KiB
    const { fetch } = serving(JSON.stringify({ return_to: ['https://a.example/back'], pad: 'x'.repeat(64 * 1024) }));

    // When the return address is checked
    const verdict = await checkReturnTo('https://a.example/back', { fetch, signal });

    // Then it is not listed
    expect(verdict).toEqual({ ok: false, reason: 'return_to_not_listed' });
  });

  it('As a site, I stream a well-known file past 64 KiB and the window stops reading and reads it as not listing the address', async () => {
    // Given a body that never ends and records when the reader cancels it
    let cancelled = false;
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetch } = fakeFetch(() => Promise.resolve(new Response(body)));

    // When the return address is checked
    const verdict = await checkReturnTo('https://a.example/back', { fetch, signal });

    // Then the body is cancelled and the address is not listed
    expect(cancelled).toBe(true);
    expect(verdict).toEqual({ ok: false, reason: 'return_to_not_listed' });
  });

  it('As a site, I stream a small well-known file in pieces and the window reads it whole', async () => {
    // Given a listing split across two streamed chunks, with a multi-byte character cut between them
    const bytes = new TextEncoder().encode(JSON.stringify({ return_to: ['https://a.example/back'], note: 'é' }));
    const cut = bytes.length - 6;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    const { fetch } = fakeFetch(() => Promise.resolve(new Response(body)));

    // When the return address is checked
    const verdict = await checkReturnTo('https://a.example/back', { fetch, signal });

    // Then it is accepted
    expect(verdict).toEqual({ ok: true });
  });

  it('As a site whose well-known body fails midway, I am read as unreachable', async () => {
    // Given a body that errors after its first chunk
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        controller.error(new TypeError('network error'));
      },
    });
    const { fetch } = fakeFetch(() => Promise.resolve(new Response(body)));

    // When the return address is checked
    const verdict = await checkReturnTo('https://a.example/back', { fetch, signal });

    // Then the file is unreachable and nothing throws
    expect(verdict).toEqual({ ok: false, reason: 'well_known_unreachable' });
  });

  it('As a site, I host the well-known file and the window fetches it from my origin with no credentials, redirect or cache', async () => {
    // Given a site that lists its return address
    const { fetch, calls } = listing('https://a.example/back?x=1');

    // When a return address with a path and query is checked
    await checkReturnTo('https://a.example/back?x=1', { fetch, signal });

    // Then the file is fetched once from the origin with the strict options
    expect(calls).toEqual([
      {
        input: 'https://a.example/.well-known/polkadot-signin.json',
        init: { credentials: 'omit', redirect: 'error', cache: 'no-store', signal },
      },
    ]);
  });
});
