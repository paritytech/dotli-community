#!/usr/bin/env bun
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

//
// Unified preview server for perf tests.
// Routes by hostname to serve all builds from a single port:
//   host.localhost:PORT   ->  dist/protocol/
//   *.app.localhost:PORT  ->  dist/app/
//   *.localhost:PORT      ->  dist/host/
//
// This mirrors production nginx routing where host.dot.li, *.app.dot.li,
// and *.dot.li are served from separate builds.

import { existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const PORT = parseInt(process.env.PORT ?? "5173", 10);
const ROOT = join(import.meta.dir, "..");
// Monorepo layout: apps/host/dist/, apps/sandbox/dist/, apps/protocol/dist/
const HOST_DIR = join(ROOT, "apps/host/dist");
const APP_DIR = join(ROOT, "apps/sandbox/dist");
const PROTOCOL_DIR = join(ROOT, "apps/protocol/dist");

// Verify builds exist. Warn for optional builds, exit for required ones.
const REQUIRED_BUILDS = ["Host", "App (sandbox)"] as const;
for (const [label, dir] of [
  ["Host", HOST_DIR],
  ["App (sandbox)", APP_DIR],
  ["Protocol", PROTOCOL_DIR],
] as const) {
  if (!existsSync(dir)) {
    const isRequired = (REQUIRED_BUILDS as readonly string[]).includes(label);
    if (isRequired) {
      console.error(
        `${label} build not found at ${dir}\nRun: bun run build (from monorepo root)`,
      );
      process.exit(1);
    }
    console.warn(
      `⚠ ${label} build not found at ${dir} — requests to this origin will 404`,
    );
  }
}

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
  ".webm": "video/webm",
  ".txt": "text/plain",
  ".scale": "application/octet-stream",
  ".map": "application/json",
};

function serveFile(filePath: string, coep: boolean): Response | null {
  try {
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) return null;
  } catch {
    return null;
  }
  const mime = MIME[extname(filePath)] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Service-Worker-Allowed": "/",
    "Access-Control-Allow-Origin": "*",
    // Loopback iframes across *.localhost subdomains (e.g. the protocol
    // iframe at host.localhost loaded inside host-playground.localhost)
    // are gated by Chrome's Private Network Access. Without this header
    // the iframe never fires `load`, the protocol bridge handshake
    // times out, and the pair flow can't surface the user-badge.
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-cache",
  };
  if (coep) {
    headers["Cross-Origin-Resource-Policy"] = "cross-origin";
    headers["Cross-Origin-Embedder-Policy"] = "credentialless";
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
  }
  return new Response(Bun.file(filePath), { headers });
}

// Dev-only mode-sync store. Production puts mode preferences on the
// `host.<BASE_DOMAIN>` iframe's localStorage (same-site iframes share
// storage across *.dot.li subdomains). On localhost every subdomain is
// its own site (the PSL lists `localhost`), so Chrome partitions the
// iframe's localStorage per embedder and cross-subdomain sharing
// breaks. This in-memory map gives the host shell a uniform store the
// preview can hit from any subdomain, with no PSL and no partitioning.
const modeStore = new Map<string, string>();
const MODE_SYNC_PREFIX = "/__dotli-mode/";
const MODE_SYNC_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  // Chrome's Private Network Access gates cross-subdomain loopback
  // requests (each `*.localhost` is its own site per PSL) and rejects
  // them with "Permission was denied for this request to access the
  // `loopback` address space" unless the server opts in. The mode-sync
  // store is the cross-origin glue between the sandbox and the host
  // shell, so without this header the host can't read its own auth /
  // backend settings and every chain-dependent product call cascades
  // into "Chain not supported" / disabled buttons.
  "Access-Control-Allow-Private-Network": "true",
  "Access-Control-Max-Age": "600",
  "Cache-Control": "no-store",
};

// Both directions speak raw text. "No value" is HTTP 204, not a JSON
// `null` body, which would force GET to disagree with PUT on encoding.
// Bare URL (`/__dotli-mode/`) DELETE wipes everything. This is the
// per-test reset used by Playwright fixtures.
async function handleModeSync(req: Request, key: string): Promise<Response> {
  const ok = (body: BodyInit | null, contentType?: string): Response => {
    const headers: Record<string, string> = { ...MODE_SYNC_CORS };
    if (contentType !== undefined) headers["Content-Type"] = contentType;
    return new Response(body, { status: body === null ? 204 : 200, headers });
  };
  const empty = (status: number): Response =>
    new Response(null, { status, headers: MODE_SYNC_CORS });

  if (req.method === "OPTIONS") return empty(204);

  if (req.method === "DELETE") {
    if (key === "") modeStore.clear();
    else modeStore.delete(key);
    return empty(204);
  }

  if (key === "") {
    return new Response("Missing key", {
      status: 400,
      headers: MODE_SYNC_CORS,
    });
  }

  if (req.method === "GET") {
    const value = modeStore.get(key);
    return value === undefined ? empty(204) : ok(value, MIME[".txt"]);
  }
  if (req.method === "PUT") {
    modeStore.set(key, await req.text());
    return empty(204);
  }
  return new Response("Method not allowed", {
    status: 405,
    headers: MODE_SYNC_CORS,
  });
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.startsWith(MODE_SYNC_PREFIX)) {
      const key = decodeURIComponent(
        url.pathname.slice(MODE_SYNC_PREFIX.length),
      );
      return handleModeSync(req, key);
    }

    const isProtocol = url.hostname === "host.localhost";
    const isApp = url.hostname.includes(".app.");
    const baseDir = isProtocol ? PROTOCOL_DIR : isApp ? APP_DIR : HOST_DIR;
    const fallback = "index.html";

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = `/${fallback}`;

    // Mirror nginx: COEP applies to the app and protocol builds (iframeable
    // origins) and to the /__preview location on the host build, but not
    // to the rest of the host build. Otherwise the /localhost:<port>
    // proxy iframe gets blocked.
    const coep = isApp || isProtocol || pathname.startsWith("/__preview");

    // Try exact file
    const exact = join(baseDir, pathname);
    const res = serveFile(exact, coep);
    if (res) return res;

    // Try directory index
    const res2 = serveFile(join(exact, "index.html"), coep);
    if (res2) return res2;

    // SPA fallback
    return (
      serveFile(join(baseDir, fallback), coep) ??
      new Response("Not Found", { status: 404 })
    );
  },
});

console.log(`Preview server on http://localhost:${PORT}`);
console.log(`  Host: ${HOST_DIR}`);
console.log(`  App:  ${APP_DIR}`);
console.log(`  Protocol: ${PROTOCOL_DIR}`);
