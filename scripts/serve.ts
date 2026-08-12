// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Standalone server for a built dot.li bundle — the runner shipped in the
// release tarball for environments without Docker.
//
//   node serve.mjs          # or: bun serve.mjs
//
// Written against node builtins only, so one implementation runs under both
// node and bun. Bundled to serve.mjs at release time because node cannot
// execute TypeScript directly.
//
// Mirrors nginx/nginx.docker.conf.template: same hostname routing, the same
// headers, precompressed siblings, immutable asset caching and SPA fallback.
// **If you change the serving rules in one, change them in the other** — nothing
// enforces it, and a mismatch means a local run behaves differently from a
// deployed one. The headers here are the reason this exists rather than
// `python3 -m http.server`: the sandbox isolation model depends on
// frame-ancestors and COEP, so serving without them tests a different product.
//
// Configuration, all optional:
//   PORT           listen port (default 5173; must not be 80, see below)
//   HOST           bind address (default 127.0.0.1 — see below)
//   DIST           directory holding host/, app/, protocol/ (default ./dist)
//   DOTLI_NETWORK  runtime network config JSON, same format as the container
//
// Binds loopback by default. The bundle is only usable over `*.localhost`
// anyway — browsers resolve those to loopback, treat them as a secure context so
// service workers and SharedWorker work, and `deriveBaseDomain` has a matching
// special case. Reaching it from elsewhere therefore means a tunnel
// (`ssh -L 5173:localhost:5173 vm`), which routes over loopback on the client
// side, and routing here is decided by the Host header so the tunnel is
// transparent. Binding every interface would just expose an unauthenticated
// server on a port nobody can usefully browse to. Set HOST=0.0.0.0 to override,
// e.g. when fronting it with your own reverse proxy.
//
// Not 80: `getProtocolOrigin` (packages/protocol/src/client.ts) falls back to
// port 5173 when window.location.port is empty, which browsers leave empty on
// the default HTTP port, so the protocol iframe would be looked for on the wrong
// port and never load.

import { createServer, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { runtimeNetworkConfigScriptBody } from "../packages/config/src/runtime-network-config-plugin";

const PORT = Number(process.env.PORT ?? "5173");
const HOST = process.env.HOST ?? "127.0.0.1";
const DIST = resolve(process.env.DIST ?? "dist");
const RUNTIME_CONFIG_PATH = "/dotli-network.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".scale": "application/octet-stream",
  ".map": "application/json",
};

/**
 * Which build serves a request, from its Host header. Mirrors the four server
 * blocks in the nginx profile: `host.` is exact, `*.app.` wins over `*.` because
 * it is the longer match, and everything else is the host shell.
 */
function routeFor(hostHeader: string): { dir: string; iframeable: boolean } {
  const hostname = (hostHeader.split(":")[0] ?? "").toLowerCase();
  if (hostname === "host.localhost") {
    return { dir: join(DIST, "protocol"), iframeable: true };
  }
  if (hostname.includes(".app.")) {
    return { dir: join(DIST, "app"), iframeable: true };
  }
  return { dir: join(DIST, "host"), iframeable: false };
}

/**
 * Security headers, split exactly as nginx/snippets/dotli-headers-*.conf do.
 * The iframeable origins carry frame-ancestors plus the cross-origin isolation
 * trio; the host build gets X-Frame-Options instead and is not iframeable.
 */
function securityHeaders(iframeable: boolean): Record<string, string> {
  const shared = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Access-Control-Allow-Origin": "*",
  };
  if (!iframeable) {
    return { ...shared, "X-Frame-Options": "SAMEORIGIN" };
  }
  return {
    ...shared,
    // Ports matter: CSP host-sources without one mean the scheme's default.
    "Content-Security-Policy":
      "frame-ancestors http://localhost:* http://*.localhost:*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cross-Origin-Embedder-Policy": "credentialless",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

/** Cache policy per path, matching dotli-assets-*.conf and dotli-sw-*.conf. */
function cacheControl(pathname: string): string {
  if (pathname.startsWith("/assets/")) {
    return "public, max-age=31536000, immutable";
  }
  if (pathname === "/host-sw.js" || pathname === "/app-sw.js") {
    return "no-cache";
  }
  return "no-cache";
}

/**
 * Pick a precompressed sibling when the client accepts it, matching
 * `brotli_static` / `gzip_static`. Brotli first: the build emits both and it is
 * the smaller of the two.
 */
function negotiate(
  filePath: string,
  acceptEncoding: string,
): { path: string; encoding?: string } {
  if (acceptEncoding.includes("br") && existsSync(`${filePath}.br`)) {
    return { path: `${filePath}.br`, encoding: "br" };
  }
  if (acceptEncoding.includes("gzip") && existsSync(`${filePath}.gz`)) {
    return { path: `${filePath}.gz`, encoding: "gzip" };
  }
  return { path: filePath };
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function send(
  res: ServerResponse,
  filePath: string,
  pathname: string,
  iframeable: boolean,
  acceptEncoding: string,
): void {
  const chosen = negotiate(filePath, acceptEncoding);
  const headers: Record<string, string> = {
    // Content-Type comes from the *logical* path, not the .br/.gz sibling.
    "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": cacheControl(pathname),
    ...securityHeaders(iframeable),
  };
  if (chosen.encoding !== undefined) {
    headers["Content-Encoding"] = chosen.encoding;
    headers.Vary = "Accept-Encoding";
  }
  if (pathname === "/host-sw.js" || pathname === "/app-sw.js") {
    headers["Service-Worker-Allowed"] = "/";
  }
  res.writeHead(200, headers);
  createReadStream(chosen.path).pipe(res);
}

if (PORT === 80) {
  console.error(
    "serve: PORT=80 is not supported — the bundle derives the protocol iframe's\n" +
      "origin from window.location.port, which browsers leave empty on port 80, so\n" +
      "the iframe would be looked for on port 5173 and never load. Use another port.",
  );
  process.exit(1);
}

for (const sub of ["host", "app", "protocol"]) {
  if (!existsSync(join(DIST, sub))) {
    console.error(
      `serve: ${join(DIST, sub)} not found.\n` +
        `Expected ${DIST} to contain host/, app/ and protocol/.\n` +
        `Set DIST=<path> if the bundle is elsewhere.`,
    );
    process.exit(1);
  }
}

createServer((req, res) => {
  const { dir, iframeable } = routeFor(req.headers.host ?? "");
  const url = new URL(req.url ?? "/", "http://placeholder");
  const acceptEncoding = req.headers["accept-encoding"] ?? "";
  const accept = Array.isArray(acceptEncoding)
    ? acceptEncoding.join(",")
    : acceptEncoding;

  // Runtime network config, same path and same $DOTLI_NETWORK as the container.
  // Ahead of the static branches: the SPA fallback would answer with index.html,
  // and HTML where a <script> expects JavaScript fails as a syntax error rather
  // than as a missing file.
  if (url.pathname === RUNTIME_CONFIG_PATH) {
    const body = runtimeNetworkConfigScriptBody();
    res.writeHead(200, {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-store",
      ...securityHeaders(iframeable),
    });
    res.end(body);
    return;
  }

  // `normalize` then confine to `dir`, so `..` cannot escape the bundle.
  const requested = normalize(decodeURIComponent(url.pathname));
  const candidate = join(dir, requested);
  if (!candidate.startsWith(dir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  if (requested !== "/" && isFile(candidate)) {
    send(res, candidate, url.pathname, iframeable, accept);
    return;
  }

  const index = join(dir, "index.html");
  if (isFile(index)) {
    send(res, index, "/index.html", iframeable, accept);
    return;
  }
  res.writeHead(404).end("Not Found");
}).listen(PORT, HOST, () => {
  const config = process.env.DOTLI_NETWORK?.trim();
  console.log(
    `dot.li serving ${DIST} on http://localhost:${String(PORT)} (bound ${HOST})`,
  );
  console.log(`  shell     http://browse.localhost:${String(PORT)}`);
  console.log(`  protocol  http://host.localhost:${String(PORT)}`);
  console.log(
    `  network   ${config === undefined || config === "" ? "built-in (set DOTLI_NETWORK to override)" : config}`,
  );
});
