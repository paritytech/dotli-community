// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { getMimeType } from './mime.js';

describe('getMimeType', () => {
  it('As a sandbox serving a product file, I serve .html as text/html', () => {
    // When / Then
    expect(getMimeType('index.html')).toBe('text/html');
  });

  it('As a sandbox serving a product file, I serve .htm as text/html', () => {
    // When / Then
    expect(getMimeType('page.htm')).toBe('text/html');
  });

  it('As a sandbox serving a product file, I serve .js as application/javascript', () => {
    // When / Then
    expect(getMimeType('app.js')).toBe('application/javascript');
  });

  it('As a sandbox serving a product file, I serve .mjs as application/javascript', () => {
    // When / Then
    expect(getMimeType('module.mjs')).toBe('application/javascript');
  });

  it('As a sandbox serving a product file, I serve .css as text/css', () => {
    // When / Then
    expect(getMimeType('styles.css')).toBe('text/css');
  });

  it('As a sandbox serving a product file, I serve .json as application/json', () => {
    // When / Then
    expect(getMimeType('data.json')).toBe('application/json');
  });

  it('As a sandbox serving a product file, I serve .wasm as application/wasm', () => {
    // When / Then
    expect(getMimeType('module.wasm')).toBe('application/wasm');
  });

  it('As a sandbox serving a product file, I serve each image type under its own MIME type', () => {
    // When / Then
    expect(getMimeType('photo.png')).toBe('image/png');
    expect(getMimeType('photo.jpg')).toBe('image/jpeg');
    expect(getMimeType('photo.jpeg')).toBe('image/jpeg');
    expect(getMimeType('anim.gif')).toBe('image/gif');
    expect(getMimeType('icon.svg')).toBe('image/svg+xml');
    expect(getMimeType('favicon.ico')).toBe('image/x-icon');
    expect(getMimeType('img.webp')).toBe('image/webp');
  });

  it('As a sandbox serving a product file, I serve each font type under its own MIME type', () => {
    // When / Then
    expect(getMimeType('font.woff')).toBe('font/woff');
    expect(getMimeType('font.woff2')).toBe('font/woff2');
    expect(getMimeType('font.ttf')).toBe('font/ttf');
    expect(getMimeType('font.otf')).toBe('font/otf');
  });

  it('As a sandbox serving a product file, I serve each audio and video type under its own MIME type', () => {
    // When / Then
    expect(getMimeType('video.mp4')).toBe('video/mp4');
    expect(getMimeType('video.webm')).toBe('video/webm');
    expect(getMimeType('audio.mp3')).toBe('audio/mpeg');
    expect(getMimeType('audio.wav')).toBe('audio/wav');
    expect(getMimeType('audio.ogg')).toBe('audio/ogg');
  });

  it('As a sandbox serving a product file, I serve an unknown extension as application/octet-stream', () => {
    // When / Then
    expect(getMimeType('file.xyz')).toBe('application/octet-stream');
  });

  it('As a sandbox serving a product file, I serve a file without an extension as application/octet-stream', () => {
    // When / Then
    expect(getMimeType('Makefile')).toBe('application/octet-stream');
  });

  it('As a sandbox serving a product file, I serve a file with two extensions by its last one', () => {
    // When / Then
    expect(getMimeType('archive.tar.gz')).toBe('application/octet-stream');
    expect(getMimeType('styles.module.css')).toBe('text/css');
  });

  it('As a sandbox serving a product file, I serve an extension in capitals as its lowercase type', () => {
    // When / Then
    expect(getMimeType('FILE.HTML')).toBe('text/html');
    expect(getMimeType('image.PNG')).toBe('image/png');
    expect(getMimeType('style.CSS')).toBe('text/css');
  });

  it('As a sandbox serving a product file, I serve a file in a directory by its extension', () => {
    // When / Then
    expect(getMimeType('assets/js/app.js')).toBe('application/javascript');
    expect(getMimeType('/deep/path/to/image.png')).toBe('image/png');
  });

  it('As a sandbox serving a product file, I serve a dotfile with no other extension as application/octet-stream', () => {
    // When / Then
    expect(getMimeType('.gitignore')).toBe('application/octet-stream');
  });
});
