// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export const IDENTITY_PROXY_PREFIX = "/__dotli-identity";
const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 30_000;
const UPSTREAMS = {
  paseo: "https://identity.dotspark.app/api/v1/",
  testnet: "https://identity-previewnet.dotspark.app/api/v1/",
} as const;
const REQUEST_HEADERS = [
  "Content-Type",
  "Authorization",
  "Auth-ClientId",
  "Auth-ClientProof",
  "Auth-Challenge",
];

function failure(status: number, message: string, allow?: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      ...(allow ? { Allow: allow } : {}),
    },
  });
}

/** Only shell/root origins may use this endpoint, never protocol or app origins. */
export async function handleIdentityProxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.hostname.startsWith("host.") || /(^|\.)app\./.test(url.hostname)) {
    return failure(404, "Not Found");
  }
  // Also reject sandbox callers targeting a shell origin. No CORS is exposed.
  const origin = req.headers.get("Origin");
  const site = req.headers.get("Sec-Fetch-Site");
  if (
    (origin !== null &&
      origin !== `http://${url.host}` &&
      origin !== `https://${url.host}`) ||
    (site !== null && site !== "same-origin" && site !== "none")
  ) {
    return failure(403, "Forbidden");
  }
  const route =
    /^\/__dotli-identity\/(paseo|testnet)\/(auth\/challenges|auth\/token|attester|usernames\/available|usernames)$/.exec(
      url.pathname,
    );
  if (!route) return failure(404, "Not Found");
  const network = route[1] as keyof typeof UPSTREAMS;
  const endpoint = route[2]!;
  if (
    url.search &&
    !(endpoint === "usernames/available" && url.search === "?version=v1")
  ) {
    return failure(404, "Not Found");
  }
  const method = endpoint === "attester" ? "GET" : "POST";
  if (req.method !== method) return failure(405, "Method Not Allowed", method);
  const length = req.headers.get("Content-Length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)
  ) {
    return failure(413, "Payload Too Large");
  }

  let body: ArrayBuffer | undefined;
  if (req.body !== null) {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => {});
    }, TIMEOUT_MS);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (timedOut) return failure(408, "Request Timeout");
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {});
          return failure(413, "Payload Too Large");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      body = bytes.buffer;
    } catch {
      return failure(400, "Invalid Request Body");
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const upstream = await fetch(UPSTREAMS[network] + endpoint + url.search, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal,
    });
    const responseHeaders = new Headers({
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    for (const name of ["Content-Type", "WWW-Authenticate", "Retry-After"]) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    // Do not forward cookies, CORS, Location, or caching headers. In particular,
    // a redirect must not send the browser's auth proof to another origin.
    const responseBody = await upstream.arrayBuffer();
    return new Response(
      [204, 205, 304].includes(upstream.status) ? null : responseBody,
      {
        status: upstream.status,
        headers: responseHeaders,
      },
    );
  } catch {
    // Never log the request, proof headers, token response, or fetch exception.
    return signal.aborted
      ? failure(504, "Gateway Timeout")
      : failure(502, "Bad Gateway");
  }
}

/** Node/Bun HTTP adapter, shared by the release runner and Vite middleware. */
export async function handleNodeIdentityProxy(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined)
        headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
    const init: RequestInit & { duplex?: "half" } = {
      method: req.method,
      headers,
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }
    const response = await handleIdentityProxy(
      new Request(
        new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`),
        init,
      ),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(400, { "Cache-Control": "no-store" }).end("Bad Request");
  }
}
