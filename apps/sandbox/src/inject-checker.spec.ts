// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { injectSandboxChecker } from './inject-checker.js';

describe('injectSandboxChecker', () => {
  it("As a product developer, the checker runs before any of my page's scripts", () => {
    // Given a product page with its own head script
    const html = '<html><head><script src="app.js"></script></head></html>';

    // When
    const checked = injectSandboxChecker(html);

    // Then the first thing in the head is the bundled checker, as one classic script
    const first = /^<html><head><script>([\s\S]*?)<\/script><script src="app.js">/.exec(checked);
    expect(first?.[1]).toContain('DOTLI_API_VIOLATION');
    expect(first?.[1]).not.toMatch(/\bimport\b|\bexport\b/);
  });

  it('As a product developer with a page that has no head, the checker still comes first', () => {
    // Given
    const html = '<p>hello</p>';

    // When
    const checked = injectSandboxChecker(html);

    // Then
    expect(checked).toMatch(/^<script>[\s\S]*<\/script><p>hello<\/p>$/);
  });
});
