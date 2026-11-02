// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { getMimeType } from './getMimeType.js';

describe('getMimeType', () => {
  it.each([
    ['index.html', 'text/html'],
    ['page.htm', 'text/html'],
    ['app.js', 'application/javascript'],
    ['module.mjs', 'application/javascript'],
    ['styles.css', 'text/css'],
    ['data.json', 'application/json'],
    ['module.wasm', 'application/wasm'],
    ['photo.png', 'image/png'],
    ['photo.jpg', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['anim.gif', 'image/gif'],
    ['icon.svg', 'image/svg+xml'],
    ['favicon.ico', 'image/x-icon'],
    ['img.webp', 'image/webp'],
    ['font.woff', 'font/woff'],
    ['font.woff2', 'font/woff2'],
    ['font.ttf', 'font/ttf'],
    ['font.otf', 'font/otf'],
    ['video.mp4', 'video/mp4'],
    ['video.webm', 'video/webm'],
    ['audio.mp3', 'audio/mpeg'],
    ['audio.wav', 'audio/wav'],
    ['audio.ogg', 'audio/ogg'],
  ])("As a product developer, I ship %s and the sandbox serves it as %s, its extension's own type", (path, type) => {
    // Given a product file whose extension has a known type

    // When
    const served = getMimeType(path);

    // Then
    expect(served).toBe(type);
  });

  it.each([
    ['an unknown extension', 'file.xyz', 'application/octet-stream'],
    ['no extension', 'Makefile', 'application/octet-stream'],
    ['two extensions, the last unknown', 'archive.tar.gz', 'application/octet-stream'],
    ['two extensions, the last known', 'styles.module.css', 'text/css'],
    ['an HTML extension in capitals', 'FILE.HTML', 'text/html'],
    ['an image extension in capitals', 'image.PNG', 'image/png'],
    ['a style extension in capitals', 'style.CSS', 'text/css'],
    ['a relative directory', 'assets/js/app.js', 'application/javascript'],
    ['an absolute directory', '/deep/path/to/image.png', 'image/png'],
    ['a dotfile with no other extension', '.gitignore', 'application/octet-stream'],
  ])('As a product developer, I ship a file with %s, %s, and the sandbox serves it as %s', (_shape, path, type) => {
    // Given a product file whose name has that shape

    // When
    const served = getMimeType(path);

    // Then
    expect(served).toBe(type);
  });
});
