// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { checkReturnTo } from './checkReturnTo.js';

type FetchCall = {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
};

type ServeBodyParams = {
  /** The answer's HTTP status, 200 by default. */
  status?: number;
};

const RETURN_TO = 'https://a.example/back';

// A read no deadline has cut short.
const signal = new AbortController().signal;

/**
 * A fetch that answers every request with `respond()`, or rejects with the signal's reason once it is aborted, as the
 * page's fetch does, and records what it was asked.
 */
function createFakeFetch(respond: () => Promise<Response>) {
  const calls: FetchCall[] = [];
  async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    calls.push({ input, init });
    init?.signal?.throwIfAborted();
    return respond();
  }
  return { fetch, calls };
}

/** Answers with `body` and `status`. */
function serveBody(body: string, { status = 200 }: ServeBodyParams = {}): Promise<Response> {
  return Promise.resolve(new Response(body, { status }));
}

/** Answers with a well-known file that lists `entries`. */
function serveListing(...entries: unknown[]): Promise<Response> {
  return serveBody(JSON.stringify({ return_to: entries }));
}

/** Answers with a body streamed as `chunks`, which then ends. */
function serveChunks(chunks: Uint8Array[]): Promise<Response> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return Promise.resolve(new Response(body));
}

/** A listing of {@link RETURN_TO} split across two chunks, with a multi-byte character cut between them. */
function serveSplitListing(): Promise<Response> {
  const bytes = new TextEncoder().encode(JSON.stringify({ return_to: [RETURN_TO], note: 'é' }));
  const cut = bytes.length - 6;
  return serveChunks([bytes.slice(0, cut), bytes.slice(cut)]);
}

/** Answers with a body that errors after its first chunk. */
function serveBrokenBody(): Promise<Response> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
      controller.error(new TypeError('network error'));
    },
  });
  return Promise.resolve(new Response(body));
}

describe('site return address', () => {
  it.each<{ name: string; returnTo: string; respond: () => Promise<Response> }>([
    {
      name: 'a well-known file that lists my return address',
      returnTo: RETURN_TO,
      respond: () => serveListing(RETURN_TO),
    },
    {
      name: "a well-known file that lists my origin without its slash, for the origin's root with it",
      returnTo: 'https://a.example/',
      respond: () => serveListing('https://a.example'),
    },
    { name: 'a small well-known file streamed in pieces', returnTo: RETURN_TO, respond: serveSplitListing },
  ])('As a site, I serve $name and the window accepts my return address', async ({ returnTo, respond }) => {
    // Given a site that serves that file
    const { fetch } = createFakeFetch(respond);

    // When the return address is checked
    const verdict = await checkReturnTo(returnTo, { fetch, signal });

    // Then it is accepted
    expect(verdict).toEqual({ ok: true });
  });

  it.each([
    {
      name: 'a well-known file that lists other addresses and an entry that is no URL',
      body: JSON.stringify({ return_to: ['https://a.example/other', 'not a url'] }),
    },
    { name: 'a body that is not JSON', body: 'not json' },
    { name: 'a list that is not an array', body: JSON.stringify({ return_to: RETURN_TO }) },
    { name: 'a list with a non-string entry', body: JSON.stringify({ return_to: [RETURN_TO, 7] }) },
    { name: 'an array at the top', body: JSON.stringify([RETURN_TO]) },
    { name: 'JSON null', body: 'null' },
    {
      name: 'a well-known file over 64 KiB that lists the address',
      body: JSON.stringify({ return_to: [RETURN_TO], pad: 'x'.repeat(64 * 1024) }),
    },
  ])('As a site, I serve $name and the window reads it as not listing the address', async ({ body }) => {
    // Given a site that serves that body
    const { fetch } = createFakeFetch(() => serveBody(body));

    // When the return address is checked
    const verdict = await checkReturnTo(RETURN_TO, { fetch, signal });

    // Then it is not listed
    expect(verdict).toEqual({ ok: false, reason: 'return_to_not_listed' });
  });

  it.each<{ name: string; respond: () => Promise<Response>; deadline: AbortSignal }>([
    { name: 'no well-known file', respond: () => serveBody('missing', { status: 404 }), deadline: signal },
    {
      name: 'a well-known file behind a redirect or a failing network',
      respond: () => Promise.reject(new TypeError('Failed to fetch')),
      deadline: signal,
    },
    {
      name: 'a well-known file that takes too long',
      respond: () => serveListing(RETURN_TO),
      deadline: AbortSignal.abort(new DOMException('The read timed out', 'TimeoutError')),
    },
    { name: 'a well-known body that fails midway', respond: serveBrokenBody, deadline: signal },
  ])('As a site, I serve $name and the window reads the file as unreachable', async ({ respond, deadline }) => {
    // Given a site that serves that, read under that deadline
    const { fetch } = createFakeFetch(respond);

    // When the return address is checked
    const verdict = await checkReturnTo(RETURN_TO, { fetch, signal: deadline });

    // Then the file is unreachable and nothing throws
    expect(verdict).toEqual({ ok: false, reason: 'well_known_unreachable' });
  });

  it('As a site, I stream a well-known file past 64 KiB and the window stops reading and reads it as not listing the address, even when my stream refuses the cancel', async () => {
    // Given a body that never ends and records when the reader cancels it, then refuses the cancel
    let cancelled = false;
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
        throw new TypeError('stream refuses the cancel');
      },
    });
    const { fetch } = createFakeFetch(() => Promise.resolve(new Response(body)));

    // When the return address is checked
    const verdict = await checkReturnTo(RETURN_TO, { fetch, signal });

    // Then the body is cancelled and the address is not listed
    expect(cancelled).toBe(true);
    expect(verdict).toEqual({ ok: false, reason: 'return_to_not_listed' });
  });

  it('As a site, I host the well-known file and the window fetches it from my origin with no credentials, redirect or cache', async () => {
    // Given a site that lists its return address
    const { fetch, calls } = createFakeFetch(() => serveListing('https://a.example/back?x=1'));

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
