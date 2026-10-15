// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';

type Server = ChildProcessByStdio<null, Readable, Readable>;

const SERVE = join(import.meta.dirname, 'serve.ts');
const dists: string[] = [];
const servers: Server[] = [];

/** A bundle with the three builds' folders, all the server checks for at start. */
function emptyDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'dotli-serve-'));
  for (const site of ['host', 'app', 'protocol']) {
    mkdirSync(join(dist, site));
  }
  dists.push(dist);
  return dist;
}

/** The release server on a free loopback port. */
function startServe(dist: string, network: string): Server {
  const server = spawn(process.execPath, [SERVE], {
    env: { ...process.env, DIST: dist, PORT: '0', HOST: '127.0.0.1', DOTLI_NETWORK: network },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(server);
  return server;
}

/** Everything the server writes to `stream`, read as it arrives. */
function collect(stream: Readable): () => string {
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  return () => text;
}

/** The port the server reports once it listens. Rejects if it exits first. */
function listeningPort(server: Server): Promise<number> {
  const out = collect(server.stdout);
  return new Promise((resolve, reject) => {
    server.stdout.on('data', () => {
      const port = /on http:\/\/localhost:(\d+)/.exec(out())?.[1];
      if (port !== undefined) {
        resolve(Number(port));
      }
    });
    server.once('exit', code => {
      reject(new Error(`serve exited with ${String(code)} before listening:\n${out()}`));
    });
  });
}

after(() => {
  for (const server of servers) {
    server.kill();
  }
  for (const dist of dists) {
    rmSync(dist, { recursive: true, force: true });
  }
});

describe('serve', { timeout: 20_000 }, () => {
  it('As an operator, I start the release server with a DOTLI_NETWORK that is not JSON and it refuses to start', async () => {
    // Given
    const dist = emptyDist();

    // When
    const server = startServe(dist, '{"enabled":');
    const stderr = collect(server.stderr);
    const code = await new Promise<number | null>(resolve => {
      server.once('exit', resolve);
    });

    // Then
    assert.equal(code, 1);
    assert.match(stderr(), /DOTLI_NETWORK is not valid JSON/);
  });

  it('As another site, I cannot read the config the release server sends, and the page itself gets it unchanged', async () => {
    // Given
    const server = startServe(emptyDist(), '{"enabled":["previewnet"]}');
    const port = await listeningPort(server);

    // When
    const res = await fetch(`http://127.0.0.1:${String(port)}/dotli-network.js`);
    const body = await res.text();

    // Then
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-private-network'), null);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(body, 'window.__DOTLI_NETWORK__ = {"enabled":["previewnet"]};\n');
  });
});
