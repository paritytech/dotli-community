// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { getMimeType } from './getMimeType.js';

describe('getMimeType', () => {
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
