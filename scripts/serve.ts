// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The release tarball's server for environments without Docker. Node builtins only, so the bundled serve.mjs runs
// under node and bun.
// Routes and headers come from the shared serving table, which a spec holds to nginx's snippets. Sandbox isolation
// depends on them.
// Binds loopback by default because the bundle only works over `*.localhost`, so remote use goes through a tunnel.

import { createServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream';
import {
  RUNTIME_NETWORK_CONFIG_HEADERS,
  RUNTIME_NETWORK_CONFIG_PATH,
  runtimeNetworkConfigScriptBody,
} from '@config/vite/runtime-network-config';
import {
  createLocalServing,
  headerPolicy,
  pathInBuild,
  requestHostname,
  resolveFile,
  type HeaderPolicy,
  type Site,
} from '@config/vite/serving';
import { LOCAL_ROOTS } from '@dotli/config/local-roots';

const PORT = Number(process.env['PORT'] ?? '5173');
const HOST = process.env['HOST'] ?? '127.0.0.1';
const DIST = resolve(process.env['DIST'] ?? 'dist');
const serving = createLocalServing(LOCAL_ROOTS);

const DIRS: Record<Site, string> = {
  host: join(DIST, 'host'),
  app: join(DIST, 'app'),
  protocol: join(DIST, 'protocol'),
};

/** Matches `brotli_static` and `gzip_static`. Brotli first, as the smaller. */
function negotiate(filePath: string, acceptEncoding: string): { path: string; encoding?: string } {
  if (acceptEncoding.includes('br') && existsSync(`${filePath}.br`)) {
    return { path: `${filePath}.br`, encoding: 'br' };
  }
  if (acceptEncoding.includes('gzip') && existsSync(`${filePath}.gz`)) {
    return { path: `${filePath}.gz`, encoding: 'gzip' };
  }
  return { path: filePath };
}

function send(
  res: ServerResponse,
  filePath: string,
  pathname: string,
  policy: HeaderPolicy,
  acceptEncoding: string,
): void {
  const chosen = negotiate(filePath, acceptEncoding);
  const headers = serving.responseHeaders(filePath, pathname, policy);
  if (chosen.encoding !== undefined) {
    headers['Content-Encoding'] = chosen.encoding;
    headers['Vary'] = 'Accept-Encoding';
  }
  res.writeHead(200, headers);
  // A file that fails to read, such as one swapped out by a redeploy, ends this response and not the server.
  // Node and Bun pass `undefined` on success, whatever the types say.
  pipeline(createReadStream(chosen.path), res, (err: NodeJS.ErrnoException | null | undefined) => {
    // A client that leaves mid-file is no server failure.
    if (err === null || err === undefined || err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      return;
    }
    console.error(`serve: could not send ${chosen.path}: ${err.message}`);
  });
}

if (PORT === 80) {
  console.error(
    "serve: PORT=80 is not supported. The bundle derives the protocol iframe's\n" +
      'origin from window.location.port, which browsers leave empty on port 80, so\n' +
      'the iframe would be looked for on port 5173 and never load. Use another port.',
  );
  process.exit(1);
}

for (const dir of Object.values(DIRS)) {
  if (!existsSync(dir)) {
    console.error(
      `serve: ${dir} not found.\n` +
        `Expected ${DIST} to contain host/, app/ and protocol/.\n` +
        `Set DIST=<path> if the bundle is elsewhere.`,
    );
    process.exit(1);
  }
}

// Read once, so a $DOTLI_NETWORK that is not JSON stops the server here instead of failing its first request.
const runtimeConfigBody = runtimeNetworkConfigScriptBody(process.env['DOTLI_NETWORK']);

const server = createServer((req, res) => {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://placeholder');
  } catch {
    // A request line no URL can hold, such as `//[`, is the client's error. Throwing here would stop the server.
    res.writeHead(400).end('Bad Request');
    return;
  }
  const route = serving.routeFor(requestHostname(req.headers), url.pathname);
  const dir = DIRS[route.site];
  const acceptEncoding = req.headers['accept-encoding'] ?? '';
  const accept = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding;

  // Ahead of the SPA fallback, whose index.html would fail as a script syntax error rather than a missing file.
  if (url.pathname === RUNTIME_NETWORK_CONFIG_PATH) {
    res.writeHead(200, { ...RUNTIME_NETWORK_CONFIG_HEADERS });
    res.end(runtimeConfigBody);
    return;
  }

  const resolved = resolveFile(dir, route, pathInBuild(route, url.pathname));
  if (resolved === undefined) {
    res.writeHead(404).end('Not Found');
    return;
  }
  send(res, resolved.file, resolved.pathname, headerPolicy(route, url.pathname), accept);
});

// PORT=0 picks a free port, so the log reports the bound one.
server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : PORT;
  const config = process.env['DOTLI_NETWORK']?.trim();
  console.log(`dot.li serving ${DIST} on http://localhost:${String(port)} (bound ${HOST})`);
  console.log(`  shell     http://browse.localhost:${String(port)}`);
  console.log(`  protocol  http://localhost:${String(port)}/p/`);
  console.log(
    `  network   ${config === undefined || config === '' ? 'built-in (set DOTLI_NETWORK to override)' : config}`,
  );
});
