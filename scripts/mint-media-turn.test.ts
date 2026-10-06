// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TURN_CREDENTIAL_TTL_SECONDS,
  githubEnvExport,
  mintMediaIceServers,
  toMediaIceServers,
} from './mint-media-turn.ts';

// Recorded shape of a Cloudflare `credentials/generate` response (values replaced).
const CLOUDFLARE_RESPONSE = {
  iceServers: [
    {
      urls: [
        'stun:stun.cloudflare.com:3478',
        'stun:stun.cloudflare.com:53',
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'g0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5',
      credential: 'e9f8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8',
    },
  ],
};

const EXPECTED = [
  {
    urls: [
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp',
      'turn:turn.cloudflare.com:80?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ],
    username: CLOUDFLARE_RESPONSE.iceServers[0]?.username,
    credential: CLOUDFLARE_RESPONSE.iceServers[0]?.credential,
  },
];

describe('toMediaIceServers', () => {
  it('keeps only credentialed turn:/turns: relays off port 53, in the shape the host accepts', () => {
    const servers = toMediaIceServers(CLOUDFLARE_RESPONSE);
    assert.deepEqual(servers, EXPECTED);
    // Exactly urls/username/credential: the host's parseMediaIceServers rejects extra fields.
    assert.ok(servers.every(server => Object.keys(server).sort().join() === 'credential,urls,username'));
  });

  it('accepts the single-object iceServers shape', () => {
    assert.deepEqual(toMediaIceServers({ iceServers: CLOUDFLARE_RESPONSE.iceServers[0] }), EXPECTED);
  });

  it('rejects a response without a credentialed relay', () => {
    const [server] = CLOUDFLARE_RESPONSE.iceServers;
    assert.throws(() => toMediaIceServers({}), /no credentialed/);
    assert.throws(() => toMediaIceServers({ iceServers: [{ ...server, credential: '' }] }), /no credentialed/);
    assert.throws(
      () => toMediaIceServers({ iceServers: [{ ...server, urls: ['stun:stun.cloudflare.com:3478'] }] }),
      /no credentialed/,
    );
  });
});

describe('mintMediaIceServers', () => {
  it('requests 48-hour credentials with the bearer token and converts the response', async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const fetchImpl: typeof fetch = (url, init) => {
      request = { url: url instanceof Request ? url.url : url.toString(), init };
      return Promise.resolve(Response.json(CLOUDFLARE_RESPONSE));
    };

    assert.deepEqual(await mintMediaIceServers('key/id', 'api-token', fetchImpl), EXPECTED);
    assert.equal(request?.url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key%2Fid/credentials/generate');
    assert.equal(request.init?.method, 'POST');
    assert.deepEqual(request.init.headers, { Authorization: 'Bearer api-token', 'Content-Type': 'application/json' });
    assert.equal(request.init.body, JSON.stringify({ ttl: 172_800 }));
    assert.equal(TURN_CREDENTIAL_TTL_SECONDS, 48 * 3600);
  });

  it('fails on an HTTP error without echoing the response body', async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response('token api-token rejected', { status: 401 }));
    await assert.rejects(mintMediaIceServers('id', 'api-token', fetchImpl), (err: Error) => {
      assert.equal(err.message, 'Cloudflare TURN credential request failed: HTTP 401');
      return true;
    });
  });
});

describe('githubEnvExport', () => {
  it('masks the credential and the exported value, and exports it without the API token', () => {
    const { log, env } = githubEnvExport(EXPECTED as Parameters<typeof githubEnvExport>[0]);
    const value = JSON.stringify(EXPECTED);
    assert.ok(log.includes(`::add-mask::${String(EXPECTED[0]?.credential)}`));
    assert.ok(log.includes(`::add-mask::${value}`));
    assert.equal(env, `VITE_MEDIA_ICE_SERVERS=${value}\n`);
    assert.ok(!env.includes('api-token'));
  });
});
