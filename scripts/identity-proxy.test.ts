// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { handleIdentityProxy, handleNodeIdentityProxy, IDENTITY_PROXY_PREFIX } from './identity-proxy.ts';

interface UpstreamCall {
  url: string;
  init: RequestInit;
}

let calls: UpstreamCall[];
let upstream: () => Response;

beforeEach(() => {
  calls = [];
  upstream = () => new Response('{"attester":"0x00"}', { headers: { 'Content-Type': 'application/json' } });
  mock.method(globalThis, 'fetch', (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
    return Promise.resolve(upstream());
  });
});

afterEach(() => {
  mock.restoreAll();
});

function request(
  path: string,
  {
    host = 'paseo.fyi',
    method = 'GET',
    headers = {},
    body,
  }: Partial<{
    host: string;
    method: string;
    headers: Record<string, string>;
    body: string | Uint8Array;
  }> = {},
): Request {
  return new Request(`https://${host}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
}

const ATTESTER = `${IDENTITY_PROXY_PREFIX}/paseo/attester`;
const CHALLENGES = `${IDENTITY_PROXY_PREFIX}/paseo/auth/challenges`;

describe('identity proxy origins', () => {
  it('serves the root and product shell origins', async () => {
    for (const host of ['paseo.fyi', 'chat.paseo.fyi', 'localhost:4321', 'browse.localhost:5173']) {
      const res = await handleIdentityProxy(request(ATTESTER, { host }));
      assert.equal(res.status, 200, host);
    }
    assert.equal(calls.length, 4);
  });

  it('refuses protocol and sandbox origins as if the route did not exist', async () => {
    for (const host of [
      'host.paseo.fyi',
      'host.localhost:5173',
      'chat.app.paseo.fyi',
      'app.localhost',
      'x.app.localhost',
    ]) {
      const res = await handleIdentityProxy(request(ATTESTER, { host }));
      assert.equal(res.status, 404, host);
    }
    assert.equal(calls.length, 0);
  });

  it('accepts same-origin callers over either scheme, and navigations', async () => {
    for (const headers of [
      { Origin: 'https://paseo.fyi', 'Sec-Fetch-Site': 'same-origin' },
      { Origin: 'http://paseo.fyi' },
      { 'Sec-Fetch-Site': 'none' },
    ]) {
      const res = await handleIdentityProxy(request(ATTESTER, { headers }));
      assert.equal(res.status, 200, JSON.stringify(headers));
    }
  });

  it('refuses cross-origin callers, including a sandbox calling a shell origin', async () => {
    for (const headers of [
      { Origin: 'https://chat.app.paseo.fyi' },
      { Origin: 'https://evil.example' },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const res = await handleIdentityProxy(request(ATTESTER, { headers }));
      assert.equal(res.status, 403, JSON.stringify(headers));
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
    }
    assert.equal(calls.length, 0);
  });
});

describe('identity proxy routes', () => {
  it('maps each network to its fixed upstream', async () => {
    await handleIdentityProxy(request(`${IDENTITY_PROXY_PREFIX}/paseo/attester`));
    await handleIdentityProxy(request(`${IDENTITY_PROXY_PREFIX}/testnet/attester`));
    assert.deepEqual(
      calls.map(call => call.url),
      ['https://identity.dotspark.app/api/v1/attester', 'https://identity-previewnet.dotspark.app/api/v1/attester'],
    );
  });

  it('forwards the username availability query only in its versioned form', async () => {
    const path = `${IDENTITY_PROXY_PREFIX}/testnet/usernames/available`;
    assert.equal((await handleIdentityProxy(request(`${path}?version=v1`, { method: 'POST' }))).status, 200);
    assert.equal((await handleIdentityProxy(request(path, { method: 'POST' }))).status, 200);
    assert.deepEqual(
      calls.map(call => call.url),
      [
        'https://identity-previewnet.dotspark.app/api/v1/usernames/available?version=v1',
        'https://identity-previewnet.dotspark.app/api/v1/usernames/available',
      ],
    );
  });

  it('answers 404 for anything outside the fixed route table', async () => {
    for (const path of [
      IDENTITY_PROXY_PREFIX,
      `${IDENTITY_PROXY_PREFIX}/`,
      `${IDENTITY_PROXY_PREFIX}/polkadot/attester`,
      `${IDENTITY_PROXY_PREFIX}/paseo/`,
      `${IDENTITY_PROXY_PREFIX}/paseo/admin`,
      `${IDENTITY_PROXY_PREFIX}/paseo/attester/extra`,
      `${IDENTITY_PROXY_PREFIX}/paseo/%61ttester`,
      `${IDENTITY_PROXY_PREFIX}/paseo/attester?x=1`,
      `${IDENTITY_PROXY_PREFIX}/paseo/usernames?version=v1`,
      `${IDENTITY_PROXY_PREFIX}/paseo/usernames/available?version=v2`,
      `${IDENTITY_PROXY_PREFIX}x/paseo/attester`,
    ]) {
      const res = await handleIdentityProxy(request(path));
      assert.equal(res.status, 404, path);
    }
    assert.equal(calls.length, 0);
  });

  it('allows GET on the attester and POST everywhere else, naming the allowed method', async () => {
    const wrong = [
      [ATTESTER, 'POST', 'GET'],
      [CHALLENGES, 'GET', 'POST'],
      [`${IDENTITY_PROXY_PREFIX}/paseo/auth/token`, 'PUT', 'POST'],
      [`${IDENTITY_PROXY_PREFIX}/paseo/usernames`, 'DELETE', 'POST'],
      [ATTESTER, 'OPTIONS', 'GET'],
    ] as const;
    for (const [path, method, allow] of wrong) {
      const res = await handleIdentityProxy(request(path, { method }));
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get('Allow'), allow);
    }
    assert.equal(calls.length, 0);
  });
});

describe('identity proxy bodies', () => {
  it('forwards a POST body unchanged', async () => {
    const body = JSON.stringify({ account: '0x01' });
    const res = await handleIdentityProxy(
      request(CHALLENGES, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
    );
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(new TextDecoder().decode(calls[0]?.init.body as ArrayBuffer), body);
    assert.equal(calls[0]?.init.method, 'POST');
  });

  it('refuses a declared body over 64 KiB before reading it', async () => {
    for (const length of [String(64 * 1024 + 1), '-1', 'abc']) {
      const res = await handleIdentityProxy(
        request(CHALLENGES, { method: 'POST', headers: { 'Content-Length': length }, body: 'x' }),
      );
      assert.equal(res.status, 413, length);
    }
    assert.equal(calls.length, 0);
  });

  it('refuses a streamed body that grows past 64 KiB', async () => {
    const chunk = new Uint8Array(16 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    const res = await handleIdentityProxy(
      new Request(`https://paseo.fyi${CHALLENGES}`, { method: 'POST', body, duplex: 'half' }),
    );
    assert.equal(res.status, 413);
    assert.equal(calls.length, 0);
  });

  it('accepts a body of exactly 64 KiB', async () => {
    const res = await handleIdentityProxy(request(CHALLENGES, { method: 'POST', body: new Uint8Array(64 * 1024) }));
    assert.equal(res.status, 200);
  });
});

describe('identity proxy headers', () => {
  it('forwards only the identity API request headers, never cookies or forwarding headers', async () => {
    await handleIdentityProxy(
      request(CHALLENGES, {
        method: 'POST',
        body: '{}',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'Auth-ClientId': 'client',
          'Auth-ClientProof': 'proof',
          'Auth-Challenge': 'challenge',
          Cookie: 'session=1',
          'X-Forwarded-For': '10.0.0.1',
          Referer: 'https://paseo.fyi/',
          'User-Agent': 'browser',
          Origin: 'https://paseo.fyi',
        },
      }),
    );
    const forwarded = new Headers(calls[0]?.init.headers);
    assert.deepEqual([...forwarded.keys()].sort(), [
      'auth-challenge',
      'auth-clientid',
      'auth-clientproof',
      'authorization',
      'content-type',
    ]);
    assert.equal(forwarded.get('Auth-ClientProof'), 'proof');
  });

  it('never follows redirects or sends credentials upstream', async () => {
    await handleIdentityProxy(request(ATTESTER));
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.body, null);
  });

  it('passes the upstream status and body through, keeping only safe response headers', async () => {
    upstream = () =>
      new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer',
          'Retry-After': '5',
          'Set-Cookie': 'session=1',
          Location: 'https://elsewhere.example/',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'max-age=600',
        },
      });
    const res = await handleIdentityProxy(request(ATTESTER));
    assert.equal(res.status, 401);
    assert.equal(await res.text(), '{"error":"unauthorized"}');
    assert.deepEqual(Object.fromEntries(res.headers), {
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'cross-origin-resource-policy': 'same-origin',
      'retry-after': '5',
      'www-authenticate': 'Bearer',
    });
  });

  it('does not let an upstream redirect reach the browser', async () => {
    upstream = () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } });
    const res = await handleIdentityProxy(request(ATTESTER));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), null);
  });

  it('answers 204 without a body', async () => {
    upstream = () => new Response(null, { status: 204 });
    const res = await handleIdentityProxy(request(ATTESTER));
    assert.equal(res.status, 204);
    assert.equal(res.body, null);
  });

  it('answers 502 when the upstream is unreachable', async () => {
    mock.restoreAll();
    mock.method(globalThis, 'fetch', () => Promise.reject(new TypeError('fetch failed')));
    const res = await handleIdentityProxy(request(ATTESTER));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });
});

interface NodeRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** node:http rather than fetch, which these tests replace, and which would not let the Host header through. */
function send(port: number, path: string, { method, headers, body }: NodeRequest): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => {
    res.resume();
    res.on('end', () => {
      resolve(res.statusCode ?? 0);
    });
  });
  req.on('error', reject);
  req.end(body);
  return promise;
}

describe('identity proxy Node adapter', () => {
  it('carries the Host, Origin and body of a Node request through the same checks', async () => {
    const server = createServer((req, res) => {
      void handleNodeIdentityProxy(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    try {
      const ok = await send(port, CHALLENGES, {
        method: 'POST',
        headers: { Host: 'paseo.fyi', Origin: 'https://paseo.fyi', 'Content-Type': 'application/json' },
        body: '{"a":1}',
      });
      assert.equal(ok, 200);
      assert.equal(new TextDecoder().decode(calls[0]?.init.body as ArrayBuffer), '{"a":1}');

      const sandbox = await send(port, CHALLENGES, {
        method: 'POST',
        headers: { Host: 'chat.app.paseo.fyi', 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(sandbox, 404);

      const crossOrigin = await send(port, ATTESTER, {
        method: 'GET',
        headers: { Host: 'paseo.fyi', Origin: 'https://chat.app.paseo.fyi' },
      });
      assert.equal(crossOrigin, 403);
      assert.equal(calls.length, 1);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
