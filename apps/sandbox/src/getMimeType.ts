// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const MIME_TYPES: Record<string, string> = {
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
};

const DEFAULT_MIME = 'application/octet-stream';

/**
 * The MIME type a file path's extension names, ignoring any query or fragment, or the generic binary type. Never
 * throws.
 */
export function getMimeType(path: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(stripQueryAndFragment(path))?.[1]?.toLowerCase();
  if (extension === undefined || !Object.prototype.hasOwnProperty.call(MIME_TYPES, extension)) {
    return DEFAULT_MIME;
  }
  return MIME_TYPES[extension] ?? DEFAULT_MIME;
}

function stripQueryAndFragment(path: string): string {
  let end = path.length;
  const queryStart = path.indexOf('?');
  if (queryStart !== -1) {
    end = queryStart;
  }
  const fragmentStart = path.indexOf('#');
  if (fragmentStart !== -1 && fragmentStart < end) {
    end = fragmentStart;
  }
  return path.substring(0, end);
}
