// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li MIME type detection.
//
// Shared between archive.ts (main thread) and sw.ts (Service Worker).
//
// - Strip `?query` and `#fragment` before extracting the extension so
//   `/foo.js?v=1` doesn't fall into the unknown-extension branch.
// - Differentiate `no-ext` from `unknown-ext` from `mime-default` outcomes
//   via the discriminated `getMimeTypeResult` helper, so callers can log
//   which branch fired without parsing the response string.
const MIME_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  xml: "application/xml",
  txt: "text/plain",
  pdf: "application/pdf",
};

const DEFAULT_MIME = "application/octet-stream";

export type MimeOutcome =
  | { kind: "ok"; mime: string; ext: string }
  | { kind: "no-ext"; mime: string }
  | { kind: "unknown-ext"; mime: string; ext: string }
  | { kind: "malformed-path"; mime: string };

function stripQueryAndFragment(path: string): string {
  let end = path.length;
  const q = path.indexOf("?");
  if (q !== -1) {
    end = q;
  }
  const h = path.indexOf("#");
  if (h !== -1 && h < end) {
    end = h;
  }
  return path.substring(0, end);
}

export function getMimeTypeResult(path: string): MimeOutcome {
  const cleaned = stripQueryAndFragment(path);
  const match = /\.([a-z0-9]+)$/i.exec(cleaned);
  if (match === null) {
    if (cleaned.includes(".")) {
      return { kind: "malformed-path", mime: DEFAULT_MIME };
    }
    return { kind: "no-ext", mime: DEFAULT_MIME };
  }
  const ext = match[1].toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(MIME_TYPES, ext)) {
    return { kind: "unknown-ext", mime: DEFAULT_MIME, ext };
  }
  return { kind: "ok", mime: MIME_TYPES[ext], ext };
}

export function getMimeType(path: string): string {
  return getMimeTypeResult(path).mime;
}
