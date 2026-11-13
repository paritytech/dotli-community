// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A map, so an extension named like an object member finds nothing.
const MIME_TYPES = new Map(
  Object.entries({
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    mjs: 'application/javascript',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    webp: 'image/webp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    wasm: 'application/wasm',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    xml: 'application/xml',
    txt: 'text/plain',
    pdf: 'application/pdf',
  }),
);

/** The MIME type a file path's extension names, or the generic binary type. Never throws. */
export function getMimeType(path: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1] ?? '';
  return MIME_TYPES.get(extension.toLowerCase()) ?? 'application/octet-stream';
}
